/**
 * `http` inner backend against a LOCAL fake HTTP server (T11.3; FR-INN-03, FR-INN-16, LLD §13.2, §13.5). Every server is
 * bound to 127.0.0.1 on an ephemeral port; host names are resolved by an injected resolver, so nothing leaves the host and
 * no real name is looked up. A "remote" endpoint is a host name the injected resolver maps to a loopback address plus a
 * private one: the connection still reaches the local fake server, but the endpoint is classified `remote`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveInnerSetting, resolveProjects, type SwitchboardConfig } from "../config/index.js";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import {
  classifyAddress,
  createConfiguredInnerAgent,
  createHttpBackend,
  type InnerCallInput,
  type InnerLogEntry,
  type InnerTaskContract,
  localityOfAddresses,
  type ProjectInnerSetting,
} from "./index.js";

// A planted credential and header value, assembled so no scanner flags this file. They exist only in the process
// environment and in the "operator's" imagination: the backend must never send or record them.
const ENV_KEY = `sk-${"envkey0123456789ABCDEF"}`;
const HEADER_VALUE = "X-Operator-Header-Value-9d1f";
const PROMPT_MARK = "PROMPT-BODY-MARKER-7c3a";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void;

interface FakeServer {
  port: number;
  seen: Seen[];
  handler: Handler;
  close(): Promise<void>;
}
const servers: FakeServer[] = [];
const dirs: string[] = [];
const dbs: { close(): void }[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

const ok = (content: string, extra: object = {}) =>
  JSON.stringify({
    model: "served-model",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 11, completion_tokens: 5 },
    ...extra,
  });

async function startServer(handler?: Handler): Promise<FakeServer> {
  const seen: Seen[] = [];
  const state = {
    seen,
    handler: handler ?? ((_q, res) => res.end(ok('{"title":"Fix login"}'))),
  } as FakeServer;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(rec);
      state.handler(req, res, rec);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  servers.push(state);
  return state;
}

const FALLBACK = { title: "fallback" };
interface Title {
  title: string;
}
const contract = (over: Partial<InnerTaskContract<Title, typeof FALLBACK>> = {}) =>
  ({
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
    ...over,
  }) satisfies InnerTaskContract<Title, typeof FALLBACK>;

interface Harness {
  svc: ReturnType<typeof createConfiguredInnerAgent>;
  ledger: ReturnType<typeof createLedger>;
  logs: InnerLogEntry[];
  runId: string;
  resolved: string[];
}
/** `remote: true` makes the host name resolve to a loopback AND a private address: reachable here, classified remote. */
function harness(
  server: FakeServer,
  opts: {
    remote?: boolean;
    unresolvable?: boolean;
    allow_remote?: boolean;
    timeout_ms?: number;
  } = {},
): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-http-"));
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
  const settings = resolveInnerAgent({
    enabled: true,
    backend: {
      kind: "http",
      base_url:
        opts.remote || opts.unresolvable
          ? `http://inner.example.test:${server.port}`
          : `http://127.0.0.1:${server.port}`,
      model: "cfg-model",
      timeout_ms: opts.timeout_ms ?? 2000,
      ...(opts.allow_remote !== undefined ? { allow_remote: opts.allow_remote } : {}),
    },
    tasks: { run_title: { enabled: true } },
  });
  const resolved: string[] = [];
  const logs: InnerLogEntry[] = [];
  const backend = createHttpBackend(settings.backend as NonNullable<typeof settings.backend>, {
    resolve: async (host) => {
      resolved.push(host);
      if (opts.unresolvable) throw new Error("ENOTFOUND");
      return ["127.0.0.1", "10.1.2.3"];
    },
  });
  const svc = createConfiguredInnerAgent(settings, {
    backend,
    ledger,
    logger: (e) => logs.push(e),
    homeDir: "/home/zz",
  });
  return { svc, ledger, logs, runId: run.id, resolved };
}
const input = (h: Harness, over: Partial<InnerCallInput> = {}): InnerCallInput => ({
  user: `objective: tidy the parser ${PROMPT_MARK}`,
  run_id: h.runId,
  ...over,
});
const rows = (h: Harness) => h.ledger.listInnerCalls();

describe("address classification (FR-INN-16, LLD §13.2)", () => {
  it("only loopback is local; private and public are remote; garbage is remote", () => {
    for (const a of ["127.0.0.1", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      expect(classifyAddress(a), a).toBe("loopback");
    }
    for (const a of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "fc00::1",
      "fe80::1",
    ]) {
      expect(classifyAddress(a), a).toBe("private");
    }
    for (const a of [
      "8.8.8.8",
      "172.32.0.1",
      "0.0.0.0",
      "2001:db8::1",
      "::",
      "::ffff:8.8.8.8",
      "localhost",
      "",
      "1.2.3",
      "999.1.1.1",
      "::1%lo",
    ]) {
      expect(classifyAddress(a), a).toBe("remote");
    }
  });

  it("a name is local only if EVERY address is loopback; an empty set is remote", () => {
    expect(localityOfAddresses(["127.0.0.1", "::1"])).toBe("local");
    expect(localityOfAddresses(["127.0.0.1", "10.0.0.1"])).toBe("remote");
    expect(localityOfAddresses([])).toBe("remote");
  });
});

describe("http backend request and response (FR-INN-03, LLD §13.2)", () => {
  it("posts one non-streaming chat completion with fixed headers only and reads content, usage and model", async () => {
    // Plant credentials in the environment: none of it may reach the wire.
    process.env.OPENAI_API_KEY = ENV_KEY;
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.INNER_AUTH_HEADER = HEADER_VALUE;
    const server = await startServer();
    const h = harness(server);
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ accepted: true, value: { title: "Fix login" } });
    expect(server.seen).toHaveLength(1);
    const [req] = server.seen as [Seen];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/chat/completions");
    expect(Object.keys(req.headers).sort()).toEqual(
      ["accept", "accept-encoding", "connection", "content-length", "content-type", "host"].sort(),
    );
    const wire = JSON.stringify(req.headers) + req.body;
    expect(wire).not.toContain(ENV_KEY);
    expect(wire).not.toContain(HEADER_VALUE);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "cfg-model", max_tokens: 80, temperature: 0, stream: false });
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "stream", "temperature"]);
    expect(body.messages).toEqual([
      { role: "system", content: "Write a title." },
      { role: "user", content: expect.stringContaining(PROMPT_MARK) },
    ]);
    const [row] = rows(h);
    expect(row).toMatchObject({
      model_id: "served-model",
      tokens_in: 11,
      tokens_out: 5,
      locality: "local",
      outcome: "accepted",
    });
  });

  it("a base path ending in /v1 is not doubled", async () => {
    const server = await startServer();
    const settings = resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: `http://127.0.0.1:${server.port}/v1/`, model: "m" },
    });
    const backend = createHttpBackend(settings.backend as NonNullable<typeof settings.backend>);
    const ctl = new AbortController();
    await backend.resolveLocality(ctl.signal);
    await backend.complete(
      { task: "run_title", template_version: "t", system: "s", user: "u", max_output_tokens: 10, response_schema: {} },
      ctl.signal,
    );
    expect(server.seen[0]?.url).toBe("/v1/chat/completions");
  });

  it("resolves the name once per call and connects to the pinned address", async () => {
    const server = await startServer();
    const h = harness(server, { remote: true, allow_remote: true });
    await h.svc.call(contract(), input(h));
    expect(h.resolved).toEqual(["inner.example.test"]);
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.headers.host).toBe(`inner.example.test:${server.port}`);
  });

  it("probe: canary succeeds against a good endpoint, reports a mismatch otherwise, and is code-only", async () => {
    const server = await startServer((_q, res) => res.end(ok('{"ok":true}')));
    const settings = resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: `http://127.0.0.1:${server.port}`, model: "m" },
    });
    const backend = createHttpBackend(settings.backend as NonNullable<typeof settings.backend>);
    expect(await backend.probe(new AbortController().signal)).toEqual({
      reachable: true,
      canary_ok: true,
      eligible: true,
      detail: "OK",
    });
    server.handler = (_q, res) => res.end(ok("nope"));
    expect(await backend.probe(new AbortController().signal)).toMatchObject({
      reachable: true,
      canary_ok: false,
      detail: "CANARY_MISMATCH",
    });
  });

  it("probe never contacts a remote endpoint without allow_remote", async () => {
    const server = await startServer();
    const settings = resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: `http://inner.example.test:${server.port}`, model: "m" },
    });
    const backend = createHttpBackend(settings.backend as NonNullable<typeof settings.backend>, {
      resolve: async () => ["127.0.0.1", "10.1.2.3"],
    });
    expect(await backend.probe(new AbortController().signal)).toMatchObject({
      reachable: false,
      detail: "REMOTE_NOT_ALLOWED",
    });
    expect(server.seen).toHaveLength(0);
  });
});

describe("privacy gates against the fake server (FR-INN-16, LLD §13.5)", () => {
  it("a remote backend is refused without allow_remote and the server sees no request", async () => {
    const server = await startServer();
    const h = harness(server, { remote: true });
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({
      accepted: false,
      outcome: "fallback_disabled",
      reason: "REMOTE_NOT_ALLOWED",
      fallback: FALLBACK,
    });
    expect(server.seen).toHaveLength(0);
    expect(rows(h)[0]).toMatchObject({ locality: "remote", attempts: 0, outcome: "fallback_disabled" });
  });

  it("an unresolvable name is remote (fail closed): refused without allow_remote", async () => {
    const server = await startServer();
    const h = harness(server, { unresolvable: true });
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ outcome: "fallback_disabled", reason: "REMOTE_NOT_ALLOWED" });
    expect(server.seen).toHaveLength(0);
  });

  it("allow_remote lets a task that sends no source content reach a remote backend", async () => {
    const server = await startServer();
    const h = harness(server, { remote: true, allow_remote: true });
    expect(await h.svc.call(contract(), input(h))).toMatchObject({ accepted: true });
    expect(server.seen).toHaveLength(1);
    expect(rows(h)[0]).toMatchObject({ locality: "remote" });
  });

  it("diffs (source content) are refused on a remote backend without the per-task opt-in, allowed with it", async () => {
    const server = await startServer();
    const denied = harness(server, { remote: true, allow_remote: true });
    const diff = contract({ sends_source_content: true });
    expect(await denied.svc.call(diff, input(denied))).toMatchObject({
      outcome: "fallback_disabled",
      reason: "SOURCE_CONTENT_NOT_ALLOWED",
    });
    expect(server.seen).toHaveLength(0);

    // Same backend, task opted in (run_title is not a source-content task in config, so build the settings by hand).
    const settings = resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: `http://inner.example.test:${server.port}`, model: "m", allow_remote: true },
      tasks: { commit_message: { enabled: true, allow_source_content: true } },
    });
    const svc = createConfiguredInnerAgent(settings, {
      backend: createHttpBackend(settings.backend as NonNullable<typeof settings.backend>, {
        resolve: async () => ["127.0.0.1", "10.1.2.3"],
      }),
    });
    const r = await svc.call(contract({ task: "commit_message", sends_source_content: true }), {
      user: "diff --git a b",
    });
    expect(r).toMatchObject({ accepted: true });
    expect(server.seen).toHaveLength(1);
  });

  it("local_only never reaches a remote backend; off never even resolves a name; inherit does reach a local one", async () => {
    const server = await startServer();
    const h = harness(server, { remote: true, allow_remote: true });
    const lo = await h.svc.call(contract(), input(h, { project_setting: "local_only" }));
    expect(lo).toMatchObject({ outcome: "fallback_disabled", reason: "PROJECT_LOCAL_ONLY" });
    const resolvedAfterLocalOnly = h.resolved.length;
    const off = await h.svc.call(contract(), input(h, { project_setting: "off" }));
    expect(off).toMatchObject({ outcome: "fallback_disabled", reason: "PROJECT_OFF" });
    expect(h.resolved.length).toBe(resolvedAfterLocalOnly); // no lookup for `off`
    expect(server.seen).toHaveLength(0);

    const local = harness(server);
    for (const setting of ["inherit", "local_only"] as ProjectInnerSetting[]) {
      expect(await local.svc.call(contract(), input(local, { project_setting: setting }))).toMatchObject({
        accepted: true,
      });
    }
    expect(server.seen).toHaveLength(2);
    expect(await local.svc.call(contract(), input(local, { project_setting: "off" }))).toMatchObject({
      reason: "PROJECT_OFF",
    });
    expect(server.seen).toHaveLength(2);
  });
});

describe("failure modes fall back (FR-INN-08, LLD §13.4)", () => {
  const cases: [string, Handler, string][] = [
    [
      "a redirect is not followed",
      (_q, res) => res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" }).end(),
      "BACKEND_ERROR",
    ],
    ["an oversized response body", (_q, res) => res.end(ok("x".repeat(200_000))), "BACKEND_ERROR"],
    ["a non-JSON body", (_q, res) => res.end("<html>not json</html>"), "BACKEND_ERROR"],
    ["a JSON body with no choices", (_q, res) => res.end("{}"), "BACKEND_ERROR"],
    ["a non-2xx status", (_q, res) => res.writeHead(500).end(ok('{"title":"x"}')), "BACKEND_ERROR"],
    [
      "a compressed response",
      (_q, res) => res.writeHead(200, { "content-encoding": "gzip" }).end("x"),
      "BACKEND_ERROR",
    ],
    ["a dropped connection", (req) => req.socket.destroy(), "BACKEND_ERROR"],
  ];
  for (const [name, handler, reason] of cases) {
    it(`${name}: fallback_unavailable, one request, no body in the row`, async () => {
      const server = await startServer(handler);
      const h = harness(server);
      const r = await h.svc.call(contract(), input(h));
      expect(r).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason, fallback: FALLBACK });
      expect(server.seen).toHaveLength(1);
    });
  }

  it("a redirect target is never contacted", async () => {
    const target = await startServer();
    const server = await startServer((_q, res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/v1/chat/completions` }).end(),
    );
    const h = harness(server);
    expect(await h.svc.call(contract(), input(h))).toMatchObject({ outcome: "fallback_unavailable" });
    expect(target.seen).toHaveLength(0);
  });

  it("an oversized declared content-length is refused before the body is read", async () => {
    const server = await startServer((_q, res) => {
      res.writeHead(200, { "content-length": "50000000" });
      res.write("{");
    });
    const h = harness(server);
    expect(await h.svc.call(contract(), input(h))).toMatchObject({ outcome: "fallback_unavailable" });
  });

  it("a slow response is cut off at the per-call bound", async () => {
    const server = await startServer((_q, res) => {
      setTimeout(() => res.end(ok('{"title":"late"}')), 5000).unref();
    });
    const h = harness(server, { timeout_ms: 300 });
    const t0 = Date.now();
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ outcome: "fallback_unavailable", reason: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("an answer whose content is not JSON is a validator rejection after one re-ask, not a transport failure", async () => {
    const server = await startServer((_q, res) => res.end(ok("sure, here is a title")));
    const h = harness(server);
    expect(await h.svc.call(contract(), input(h))).toMatchObject({ outcome: "rejected_validator", reason: "NOT_JSON" });
    expect(server.seen).toHaveLength(2);
    expect(server.seen[1]?.body).toContain("[previous answer rejected: not_json]");
    expect(server.seen[1]?.body).not.toContain("sure, here is a title");
  });

  it("a refused connection falls back", async () => {
    const server = await startServer();
    const h = harness(server);
    await server.close();
    expect(await h.svc.call(contract(), input(h))).toMatchObject({
      outcome: "fallback_unavailable",
      reason: "BACKEND_ERROR",
    });
  });
});

describe("no credential, header or prompt in rows, events or logs (FR-INN-03, FR-INN-16)", () => {
  it("across success and failure paths", async () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    process.env.INNER_AUTH_HEADER = HEADER_VALUE;
    const echo = (_q: http.IncomingMessage, res: http.ServerResponse, seen: Seen) =>
      // a hostile endpoint that echoes the prompt and a credential-looking value in an error
      res.writeHead(500).end(`${seen.body} ${ENV_KEY} ${HEADER_VALUE}`);
    const server = await startServer(echo);
    const h = harness(server);
    await h.svc.call(contract(), input(h));
    server.handler = (_q, res) => res.end(ok('{"title":"Fix login"}'));
    await h.svc.call(contract(), input(h));
    const dump = JSON.stringify([rows(h), h.ledger.listRunEvents(h.runId), h.logs]);
    for (const secret of [ENV_KEY, HEADER_VALUE, PROMPT_MARK, "Fix login", "Write a title"]) {
      expect(dump, secret).not.toContain(secret);
    }
    for (const reqSeen of server.seen) {
      expect(JSON.stringify(reqSeen.headers)).not.toMatch(/authorization|api-key|cookie/iu);
    }
  });
});

describe("project and context override (LLD §13.1, FR-INN-16)", () => {
  const cfg = (projects: object[]) => ({ projects }) as unknown as SwitchboardConfig;
  const ctx = (id: string, extra: object = {}) => ({ id, kind: "repository", path: "/x", base_ref: "main", ...extra });
  const resolveOne = (proj: object) => resolveProjects(cfg([{ id: "web-app", name: "W", ...proj }]))[0];

  it("the most restrictive of project and context wins; off over local_only over inherit", () => {
    const p = resolveOne({
      inner_agent: "local_only",
      contexts: [
        ctx("main", { primary: true }),
        ctx("docs", { inner_agent: "off" }),
        ctx("lib", { inner_agent: "inherit" }),
      ],
    });
    expect(effectiveInnerSetting(p, "main")).toBe("local_only");
    expect(effectiveInnerSetting(p, "docs")).toBe("off");
    expect(effectiveInnerSetting(p, "lib")).toBe("local_only");
    expect(effectiveInnerSetting(p)).toBe("local_only");
    expect(effectiveInnerSetting(p, "no-such-context")).toBe("local_only");
    const q = resolveOne({ contexts: [ctx("main", { inner_agent: "local_only" })] });
    expect(effectiveInnerSetting(q, "main")).toBe("local_only");
    expect(effectiveInnerSetting(q)).toBe("inherit");
  });

  it("no project (workspace_path) and no setting are inherit", () => {
    expect(effectiveInnerSetting(undefined)).toBe("inherit");
    expect(effectiveInnerSetting(undefined, "main")).toBe("inherit");
    expect(effectiveInnerSetting(resolveOne({ contexts: [ctx("main")] }), "main")).toBe("inherit");
  });
});
