/**
 * The pinned-address peer re-check of the `http` inner backend (T11.3, T11.14; FR-INN-16, LLD §13.2). Closes the
 * evidence gap the TDD §3.12 as-built note recorded as "the `LOCALITY_CHANGED` branch exists but no test exercises it,
 * because a loopback bind cannot be made to look remote".
 *
 * Honest scope. The full-stack case (a name that resolves to loopback at classification time and to a different address
 * at connect time) still cannot be produced on one host: `createPinnedHttpTransport` connects only to the address it
 * pinned, so the socket's peer can differ from the classification only if the pin itself is wrong. This file therefore
 * drives the transport with a deliberately inconsistent pin (gated `local`, address a non-loopback interface of this
 * host) and proves the branch does what the design says: the socket is destroyed before a byte is written and the error
 * is the fixed code, never the address. It then proves, through the scripted fake, how the pipeline records such a
 * failure. Nothing leaves the host: the only non-loopback address used is one of this machine's own interfaces, and a
 * machine with no such interface skips those two tests (reported as skipped, not as passed).
 */
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { createFakeBackend } from "./fake-backend.js";
import { classifyAddress, createPinnedHttpTransport, HttpBackendError, type Pinned } from "./http-backend.js";
import { createInnerAgent, type InnerLogEntry, type InnerTaskContract } from "./index.js";

/** A non-loopback IPv4 address of this host that a server can bind, or undefined (the dependent tests then skip). */
async function findBindableNonLoopback(): Promise<string | undefined> {
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => a !== undefined)
    .filter((a) => a.family === "IPv4" && !a.internal && classifyAddress(a.address) !== "loopback")
    .map((a) => a.address);
  for (const address of candidates) {
    const bindable = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(0, address, () => probe.close(() => resolve(true)));
    });
    if (bindable) return address;
  }
  return undefined;
}
const LAN = await findBindableNonLoopback();

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A raw TCP listener that counts connections and bytes; it never answers, so any byte written would be counted. */
async function rawListener(address: string): Promise<{ port: number; counts: { connections: number; bytes: number } }> {
  const counts = { connections: 0, bytes: 0 };
  const server = net.createServer((socket) => {
    counts.connections += 1;
    socket.on("data", (chunk: Buffer) => {
      counts.bytes += chunk.length;
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, address, r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port: (server.address() as AddressInfo).port, counts };
}

const OK_REPLY = JSON.stringify({
  model: "served-model",
  choices: [{ index: 0, message: { role: "assistant", content: '{"title":"Fix login"}' } }],
});

async function httpListener(address: string): Promise<{ port: number; bodies: string[] }> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(OK_REPLY);
    });
  });
  await new Promise<void>((r) => server.listen(0, address, r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { port: (server.address() as AddressInfo).port, bodies };
}

const BODY = JSON.stringify({ model: "m", messages: [{ role: "user", content: "PEER-CHECK-BODY-MARKER" }] });
const settle = () => new Promise<void>((r) => setTimeout(r, 100));

describe("socket peer re-check on a call gated local (LLD §13.2 pinned address; LOCALITY_CHANGED)", () => {
  it.skipIf(LAN === undefined)(
    "a `local` pin whose established peer is not loopback is refused with the fixed code before any byte is written",
    async () => {
      const lan = LAN as string;
      const listener = await rawListener(lan);
      // The injected resolver is never consulted: the pin is handed to `post` directly, which is the only way on one
      // host to make the peer disagree with the classification (see the file comment).
      const transport = createPinnedHttpTransport(
        `http://inner.example.test:${listener.port}`,
        "chat/completions",
        () => Promise.resolve(["127.0.0.1"]),
      );
      const pin: Pinned = { address: lan, family: 4, locality: "local" };
      const signal = new AbortController().signal;
      let caught: unknown;
      try {
        await transport.post(BODY, pin, 1 << 20, signal);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HttpBackendError);
      const err = caught as HttpBackendError;
      expect(err.code).toBe("LOCALITY_CHANGED");
      // The error carries the fixed code only: not the peer address, not the pinned address, not the body.
      expect(err.message).toBe("LOCALITY_CHANGED");
      expect(`${err.message}${err.stack ?? ""}`).not.toContain(lan);
      expect(`${err.message}${err.stack ?? ""}`).not.toContain("PEER-CHECK-BODY-MARKER");
      await settle();
      // One connection was established (the check needs an established socket) and nothing was written on it.
      expect(listener.counts).toEqual({ connections: 1, bytes: 0 });
    },
  );

  it.skipIf(LAN === undefined)(
    "the same peer passes when the call was gated `remote` (the re-check guards only the `local` decision)",
    async () => {
      const lan = LAN as string;
      const server = await httpListener(lan);
      const transport = createPinnedHttpTransport(`http://inner.example.test:${server.port}`, "chat/completions", () =>
        Promise.resolve([lan]),
      );
      // What `resolvePinned` would say for this host: a private address is `remote` (FR-INN-16 "anything else").
      expect(await transport.resolvePinned()).toEqual({ address: lan, family: 4, locality: "remote" });
      const pin: Pinned = { address: lan, family: 4, locality: "remote" };
      const raw = await transport.post(BODY, pin, 1 << 20, new AbortController().signal);
      expect(JSON.parse(raw)).toMatchObject({ model: "served-model" });
      expect(server.bodies).toEqual([BODY]);
    },
  );

  it("a consistent `local` pin on loopback passes the re-check and the body is delivered", async () => {
    const server = await httpListener("127.0.0.1");
    const transport = createPinnedHttpTransport(`http://127.0.0.1:${server.port}`, "chat/completions");
    const pin = await transport.resolvePinned();
    expect(pin).toEqual({ address: "127.0.0.1", family: 4, locality: "local" });
    const raw = await transport.post(BODY, pin, 1 << 20, new AbortController().signal);
    expect(JSON.parse(raw)).toMatchObject({ model: "served-model" });
    expect(server.bodies).toEqual([BODY]);
  });
});

// ---- how the pipeline records a LOCALITY_CHANGED failure (FR-INN-08, LLD §13.4) ------------------------------------------

const FALLBACK = { title: "fallback" };
interface Title {
  title: string;
}
const contract: InnerTaskContract<Title, typeof FALLBACK> = {
  task: "run_title",
  template_version: "run_title.v1",
  system: "Write a title.",
  response_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
  sends_source_content: false,
  fallback: () => FALLBACK,
  accept: (v: unknown) => v as Title,
};

describe("pipeline handling of a LOCALITY_CHANGED transport failure (scripted fake, FR-INN-08)", () => {
  it("falls back as `fallback_unavailable` with the generic BACKEND_ERROR code; no address reaches a row, event or log", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sb-peer-"));
    dirs.push(dir);
    const db = openLedger(dir);
    dbs.push(db);
    const ledger = createLedger(db, { ids: createIdGenerator() });
    const session = ledger.createMetaSession({ objective: "o" });
    const run = ledger.createRun({
      metaSessionId: session.id,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c",
    });
    const PEER = "203.0.113.7"; // TEST-NET-3: the address a hostile re-route would have produced
    const fake = createFakeBackend({ locality: "local" });
    let completeCalls = 0;
    const backend = {
      ...fake,
      complete: () => {
        completeCalls += 1;
        // What the transport throws when the established peer is not loopback: the fixed code, nothing else.
        return Promise.reject(new HttpBackendError("LOCALITY_CHANGED"));
      },
    };
    const logs: InnerLogEntry[] = [];
    const settings = resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "cfg-model", timeout_ms: 2000 },
      tasks: { run_title: { enabled: true } },
    });
    const svc = createInnerAgent(settings, { backend, ledger, logger: (e) => logs.push(e), homeDir: "/home/zz" });

    const r = await svc.call(contract, { user: `objective: tidy the parser ${PEER}`, run_id: run.id });
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason: "BACKEND_ERROR" });
    expect(completeCalls).toBe(1); // a transport failure is never re-asked
    const rows = ledger.listInnerCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task: "run_title",
      outcome: "fallback_unavailable",
      reason: "BACKEND_ERROR",
      attempts: 1,
      locality: "local",
      run_id: run.id,
    });
    const events = ledger.listRunEvents(run.id).filter((e) => e.type.startsWith("inner_"));
    expect(events.map((e) => e.type)).toEqual(["inner_call"]);
    const callLines = logs.filter((l) => l.event === "inner.call");
    expect(callLines).toHaveLength(1);
    expect(callLines[0]).toMatchObject({ outcome: "fallback_unavailable", reason: "BACKEND_ERROR", attempts: 1 });
    // The transport's specific code is not a row or log reason (it is folded into BACKEND_ERROR), and no address text
    // from the prompt or the would-be peer reaches any record.
    const everything = JSON.stringify({ rows, events, logs, r });
    expect(everything).not.toContain("LOCALITY_CHANGED");
    expect(everything).not.toContain(PEER);
    expect(everything).not.toContain("tidy the parser");
  });
});
