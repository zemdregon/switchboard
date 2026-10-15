/**
 * T11.14 post-#362 cross-check (FR-INN-17, LLD §13.5, §13.8): README claims about `inner status`, `inner test`,
 * `inner resume` and the `doctor` inner-agent block that no test pinned on their output. The backend is the scripted
 * in-process fake (`CliIo.innerBackend`) or a fake HTTP server bound to 127.0.0.1; no provider CLI, no real network
 * host, no credential. Each case names the README sentence it pins.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { createFakeBackend } from "./index.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sb-inner-doctor-surfaces-"));
  mkdirSync(path.join(tmp, "repos"));
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeConfig(inner: Record<string, unknown> | undefined) {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(tmp, "repos")],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      ...(inner !== undefined ? { inner_agent: inner } : {}),
    }),
  );
}

const SECRET_PATH = "secret-path-9c1e";
const innerSection = (over: { backend?: Record<string, unknown>; tasks?: Record<string, unknown> } = {}) => ({
  enabled: true,
  backend: { kind: "http", base_url: `http://127.0.0.1:1/v1/${SECRET_PATH}`, model: "test-model", ...over.backend },
  tasks: over.tasks ?? { commit_message: { enabled: true } },
});

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
    adapters: new AdapterRegistry().register(new FakeAdapter()),
    ...extra,
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** Rows of `inner_call` and `usage_observation` in the on-disk ledger (empty when no ledger exists yet). */
function ledgerRows(): { innerCalls: number; observations: number } {
  if (!existsSync(dataDir)) return { innerCalls: 0, observations: 0 };
  const db = openLedger(dataDir);
  try {
    const observations = (db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get() as { n: number }).n;
    return { innerCalls: createLedger(db).listInnerCalls().length, observations };
  } finally {
    db.close();
  }
}

describe("README: inner status shows the state off, no_backend or ready; inner test exits 1 when nothing was sent", () => {
  it("enabled without a backend object is refused by the config (no default backend): every command exits 1 and writes nothing", async () => {
    // README (Configure): "there is no default backend". The `no_backend` state is therefore not reachable from an
    // on-disk `http` section; the one on-disk route to it is the `cli` kind (next case).
    writeConfig({ enabled: true, tasks: { commit_message: { enabled: true } } });
    const backend = createFakeBackend();
    const probe = vi.spyOn(backend, "probe");
    for (const args of [
      ["inner", "status"],
      ["inner", "status", "--json"],
      ["inner", "test", "commit_message"],
      ["inner", "resume", "commit_message"],
      ["doctor"],
      ["doctor", "--json"],
    ]) {
      const r = await run(args, { innerBackend: backend });
      expect(r.code, args.join(" ")).toBe(1);
      // The refusal is printed on stderr, or inside the JSON error document with --json.
      expect(r.out + r.err, args.join(" ")).toContain(
        "inner_agent.backend: required when enabled is true (no default backend)",
      );
      expect(r.out + r.err, args.join(" ")).not.toMatch(/no_backend|Inner agent/u);
    }
    expect(probe).not.toHaveBeenCalled();
    expect(backend.requests).toHaveLength(0);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("a cli backend kind: status and doctor say no_backend and Ineligible, inner test sends nothing, no process starts", async () => {
    writeConfig({
      enabled: true,
      backend: { kind: "cli", provider: "opencode", model: "m" },
      tasks: { run_title: { enabled: true } },
    });
    const status = await run(["inner", "status", "--json"]);
    expect(status.code).toBe(0);
    const view = JSON.parse(status.out).inner_agent;
    expect(view).toMatchObject({ state: "no_backend", enabled: true, breaker_state: "closed", ledger: "absent" });
    expect(view.backend).toMatchObject({ kind: "cli", provider: "opencode", eligible: false, locality: "remote" });
    // Without a usable backend no task is enabled, whatever the config switched on (createInnerAgent.taskEnabled).
    expect(view.tasks.every((t: { enabled: boolean }) => !t.enabled)).toBe(true);
    const statusText = (await run(["inner", "status"])).out;
    expect(statusText).toContain("Inner agent: no_backend\n");
    expect(statusText).toContain(
      "  backend: cli provider opencode, model m, remote, Ineligible (not implemented or not verified)\n",
    );
    expect(statusText).toContain("  ledger: none yet\n");

    const test = await run(["inner", "test", "run_title", "--json"]);
    expect(test.code).toBe(1);
    expect(JSON.parse(test.out)).toMatchObject({ ran: false, accepted: false, outcome: "no_backend", call: null });
    const testText = await run(["inner", "test", "run_title"]);
    expect(testText.code).toBe(1);
    expect(testText.out).toContain("Nothing was sent: no usable backend is configured.\n");
    expect(existsSync(dataDir)).toBe(false);

    // doctor: one [warn] with the Ineligible wording, no circuit line (there is no backend to have one), no task enabled.
    const doctor = await run(["doctor", "--json"]);
    expect(doctor.code).toBe(0);
    const j = JSON.parse(doctor.out);
    expect(j.ok).toBe(true);
    expect(j.inner_agent.state).toBe("no_backend");
    expect(j.inner_agent.resolved_locality).toBe("remote");
    expect(j.inner_agent.probe).toEqual({
      attempted: false,
      skipped_reason: "INELIGIBLE",
      reachable: null,
      canary_ok: null,
      eligible: null,
      detail: null,
    });
    expect(j.inner_agent.checks).toEqual([
      {
        id: "inner_backend",
        label: "Inner agent",
        status: "warn",
        detail:
          "cli provider opencode, model m, remote, Ineligible (not implemented or not verified); no process is started, tasks use their fallback",
      },
      { id: "inner_tasks", label: "Inner agent tasks", status: "skip", detail: "none enabled" },
    ]);
    const doctorText = (await run(["doctor"])).out;
    expect(doctorText).toContain(
      "[warn] Inner agent: cli provider opencode, model m, remote, Ineligible (not implemented or not verified); no process is started, tasks use their fallback\n",
    );
    expect(doctorText).toContain("[skip] Inner agent tasks: none enabled\n");
    expect(doctorText).not.toContain("Inner agent circuit");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("enabled: false: status text says off, inner test exits 1 naming the off reason, doctor prints one [skip] line only", async () => {
    writeConfig({ enabled: false, tasks: { commit_message: { enabled: true } } });
    const backend = createFakeBackend();
    expect((await run(["inner", "status"], { innerBackend: backend })).out).toContain(
      "Inner agent: off (disabled or not configured)\n",
    );
    const test = await run(["inner", "test", "commit_message"], { innerBackend: backend });
    expect(test.code).toBe(1);
    expect(test.out).toContain(
      "Nothing was sent: the inner agent is off (no inner_agent section, or enabled is false).\n",
    );
    const doctorText = (await run(["doctor"], { innerBackend: backend })).out;
    const block = doctorText.slice(doctorText.indexOf("Inner agent:"));
    expect(block.split("\n").filter((l) => l.includes("Inner agent") || l.includes("Inner task"))).toEqual([
      "Inner agent:",
      "[skip] Inner agent: off: disabled (every task uses its fallback)",
    ]);
    expect(backend.requests).toHaveLength(0);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("a task that is not enabled: the human text names the task and the exit code is 1", async () => {
    writeConfig(innerSection());
    const backend = createFakeBackend();
    const r = await run(["inner", "test", "run_title"], { innerBackend: backend });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Nothing was sent: the run_title task is not enabled.\n");
    expect(backend.requests).toHaveLength(0);
  });
});

describe("README: doctor shows the circuit state of the doctor process and each enabled task's rejection and fallback rates", () => {
  it("a ready backend with no calls: closed circuit, n/a rates, 0 calls; status --json carries the same breaker state", async () => {
    writeConfig(innerSection());
    const j = JSON.parse((await run(["doctor", "--json"], { innerBackend: createFakeBackend() })).out);
    expect(j.inner_agent.breaker_state).toBe("closed");
    expect(j.inner_agent.checks.slice(1)).toEqual([
      {
        id: "inner_breaker",
        label: "Inner agent circuit",
        status: "ok",
        detail: "closed in this process (the daemon's circuit is held in its memory and is not visible here)",
      },
      { id: "inner_tasks", label: "Inner agent tasks", status: "ok", detail: "enabled: commit_message" },
      {
        id: "inner_task_commit_message",
        label: "Inner task commit_message",
        status: "ok",
        detail:
          "enabled, not suspended; rejection 0/0 (n/a) over the window, threshold 40%; fallback rate n/a of 0 call(s)",
      },
    ]);
    const text = (await run(["doctor"], { innerBackend: createFakeBackend() })).out;
    expect(text).toContain(
      "[ok]   Inner agent circuit: closed in this process (the daemon's circuit is held in its memory and is not visible here)\n",
    );
    expect(text).toContain(
      "[ok]   Inner task commit_message: enabled, not suspended; rejection 0/0 (n/a) over the window, threshold 40%; fallback rate n/a of 0 call(s)\n",
    );
    expect(JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent.breaker_state).toBe("closed");
  });

  it("after an accepted, a rejected and an unavailable inner test: counts by outcome, the fallback rate and the window rate", async () => {
    writeConfig(innerSection());
    const accepted = createFakeBackend({ script: [{ kind: "text", text: '{"subject":"Fix greeting typo"}' }] });
    expect((await run(["inner", "test", "commit_message"], { innerBackend: accepted })).code).toBe(0);
    const rejected = createFakeBackend({ script: [{ kind: "text", text: "not json" }] });
    expect((await run(["inner", "test", "commit_message"], { innerBackend: rejected })).code).toBe(1);
    const failing = createFakeBackend({ script: [{ kind: "error", message: "FAKE_BACKEND_DOWN_31ab" }] });
    const unavailable = await run(["inner", "test", "commit_message"], { innerBackend: failing });
    // README: inner test exits 1 when the result would fall back.
    expect(unavailable.code).toBe(1);
    expect(unavailable.out).toContain("Result: not accepted (fallback_unavailable");
    expect(unavailable.out).toContain("the task would use its fallback");
    expect(unavailable.out).not.toContain("FAKE_BACKEND_DOWN_31ab"); // a backend's error text is never printed

    const view = JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent;
    const cm = view.tasks.find((t: { task: string }) => t.task === "commit_message");
    expect(cm.calls).toMatchObject({ accepted: 1, rejected_validator: 1, fallback_unavailable: 1 });
    expect(cm).toMatchObject({ enabled: true, suspended: false, total_calls: 3, fallback_rate: 1 / 3 });
    // Fallback outcomes are not quality evidence (T11.6): the window counts the accepted and the rejected call only.
    expect(cm.window).toEqual({ calls: 2, rejected: 1, rejection_rate: 0.5, threshold: 0.4, min_calls: 20 });
    const statusText = (await run(["inner", "status"])).out;
    expect(statusText).toMatch(/^commit_message +yes +active +3 +1 +1 +1 +33% +1\/2 \(50%\)$/mu);

    const j = JSON.parse((await run(["doctor", "--json"], { innerBackend: createFakeBackend() })).out);
    expect(j.ok).toBe(true);
    expect(j.inner_agent.checks.find((c: { id: string }) => c.id === "inner_task_commit_message")).toEqual({
      id: "inner_task_commit_message",
      label: "Inner task commit_message",
      status: "ok",
      detail:
        "enabled, not suspended; rejection 1/2 (50%) over the window, threshold 40%; fallback rate 33% of 3 call(s)",
    });
    expect(ledgerRows()).toEqual({ innerCalls: 3, observations: 0 });
  });
});

describe("README: doctor reports whether a fixed canary answered within schema and contacts the backend only for it", () => {
  async function listen(reply: string) {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "srv-model", choices: [{ message: { content: reply } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return { bodies, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("a reachable loopback server whose canary reply is off schema is a [warn] with the CANARY_MISMATCH code, exit 0", async () => {
    const srv = await listen('{"ok":false}');
    try {
      writeConfig(innerSection({ backend: { base_url: `http://127.0.0.1:${srv.port}` } }));
      const r = await run(["doctor", "--json"]);
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out);
      expect(j.ok).toBe(true);
      expect(j.inner_agent.probe).toEqual({
        attempted: true,
        skipped_reason: null,
        reachable: true,
        canary_ok: false,
        eligible: true,
        detail: "CANARY_MISMATCH",
      });
      expect(j.inner_agent.checks[0]).toMatchObject({ id: "inner_backend", status: "warn" });
      expect(j.inner_agent.checks[0].detail).toContain(
        "reachable, canary not answered within schema (CANARY_MISMATCH); tasks use their fallback",
      );
      expect(srv.bodies).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it("the canary is the only request, carries no repository, config, home or environment data, and writes no row", async () => {
    const srv = await listen('{"ok":true}');
    try {
      writeConfig(
        innerSection({
          backend: { base_url: `http://127.0.0.1:${srv.port}`, shares_subscription_with: "claude-code" },
          tasks: { commit_message: { enabled: true }, run_title: { enabled: true } },
        }),
      );
      mkdirSync(dataDir);
      openLedger(dataDir).close(); // an existing ledger, so a stray row would have somewhere to land
      const planted = "SWITCHBOARD_PLANTED_ENV_VALUE_2d7c";
      const r = await run(["doctor", "--json"], { env: { PLANTED: planted } });
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out);
      expect(j.inner_agent.probe).toMatchObject({ attempted: true, reachable: true, canary_ok: true, detail: "OK" });
      expect(j.inner_agent.checks[0]).toMatchObject({ id: "inner_backend", status: "ok" });
      expect(j.inner_agent.checks[0].detail).toContain("reachable, canary answered within schema");
      expect(srv.bodies).toHaveLength(1);
      const sent = srv.bodies[0] ?? "";
      // The fixed canary (http-backend CANARY_REQUEST): a one-line instruction and the user text "ping", JSON-escaped.
      expect(sent).toContain('Reply with exactly this JSON and nothing else: {\\"ok\\":true}');
      expect(sent).toContain('{"role":"user","content":"ping"}');
      for (const secret of [tmp, dataDir, configPath, process.cwd(), os.homedir(), planted, "mcp_clients", "c1"]) {
        expect(sent, `canary must not contain ${secret}`).not.toContain(secret);
      }
      // The canary is not an inner call (LLD §13.8): no inner_call row and, shared subscription or not, no observation.
      expect(ledgerRows()).toEqual({ innerCalls: 0, observations: 0 });
      const view = JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent;
      expect(view.tasks.every((t: { total_calls: number }) => t.total_calls === 0)).toBe(true);
      expect(srv.bodies).toHaveLength(1); // inner status never contacts the backend
    } finally {
      await srv.close();
    }
  });
});

describe("README: neither command prints a base URL's path, userinfo, a header, a key or any prompt or response text", () => {
  it("status, test and doctor print the origin only, in JSON and in text", async () => {
    writeConfig(innerSection());
    const backend = createFakeBackend({ script: [{ kind: "text", text: '{"subject":"RESPONSE_BODY_MARKER_4e"}' }] });
    const outputs = [
      await run(["inner", "status"]),
      await run(["inner", "status", "--json"]),
      await run(["inner", "test", "commit_message"], { innerBackend: backend }),
      await run(["inner", "test", "commit_message", "--json"], { innerBackend: backend }),
      await run(["doctor"], { innerBackend: backend }),
      await run(["doctor", "--json"], { innerBackend: backend }),
    ];
    for (const o of outputs) {
      expect(o.code).toBe(0);
      const printed = o.out + o.err;
      expect(printed).not.toContain(SECRET_PATH);
      expect(printed).not.toContain("/v1");
      expect(printed).not.toContain("RESPONSE_BODY_MARKER_4e");
      expect(printed).not.toContain("synthetic world");
    }
    expect(outputs[0]?.out).toContain("  backend: http http://127.0.0.1:1, model test-model, local\n");
    expect(outputs[0]?.out).toContain("  allow_remote: no; shares subscription with: none\n");
    expect(backend.requests).toHaveLength(2);
  });

  it("status text classifies a host name as unresolved and a private address as remote, origin only", async () => {
    writeConfig(innerSection({ backend: { base_url: `https://gateway.example.test:8443/v1/${SECRET_PATH}` } }));
    let text = (await run(["inner", "status"])).out;
    expect(text).toContain(
      "  backend: http https://gateway.example.test:8443, model test-model, locality unresolved (host name, classified at connect time)\n",
    );
    expect(text).not.toContain(SECRET_PATH);
    writeConfig(
      innerSection({ backend: { base_url: `http://10.1.2.3:8080/${SECRET_PATH}`, shares_subscription_with: "codex" } }),
    );
    text = (await run(["inner", "status"])).out;
    expect(text).toContain("  backend: http http://10.1.2.3:8080, model test-model, remote (private address)\n");
    expect(text).toContain("  allow_remote: no; shares subscription with: codex\n");
    expect(text).not.toContain(SECRET_PATH);
  });
});

describe("README: a suspended task falls back until inner resume, and quality counting then restarts", () => {
  it("resume prints the restart notice once; a second resume and a resume with no ledger say nothing to do", async () => {
    writeConfig({ ...innerSection(), suspension: { window_calls: 2, min_calls: 2, rejection_threshold: 0.5 } });
    const noLedger = await run(["inner", "resume", "commit_message"]);
    expect(noLedger.code).toBe(0);
    expect(noLedger.out).toBe("commit_message is not suspended (no ledger exists yet); nothing to do.\n");
    expect(existsSync(dataDir)).toBe(false);

    const bad = createFakeBackend({ script: [{ kind: "text", text: "not json" }] });
    expect((await run(["inner", "test", "commit_message"], { innerBackend: bad })).code).toBe(1);
    expect((await run(["inner", "test", "commit_message"], { innerBackend: bad })).code).toBe(1);
    const statusText = (await run(["inner", "status"])).out;
    expect(statusText).toMatch(
      /^commit_message is suspended since .*: 2 of 2 calls rejected over a window of 2 \(threshold 50%\)\.$/mu,
    );
    expect(statusText).toContain("Calls fall back until you run: switchboard inner resume commit_message\n");
    const good = createFakeBackend({ script: [{ kind: "text", text: '{"subject":"Fix greeting typo"}' }] });
    const suspended = await run(["inner", "test", "commit_message"], { innerBackend: good });
    expect(suspended.code).toBe(1);
    expect(suspended.out).toContain(
      "Result: not accepted (fallback_suspended, TASK_SUSPENDED); the task would use its fallback",
    );
    expect(good.requests).toHaveLength(0);

    const resumed = await run(["inner", "resume", "commit_message"]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toMatch(/^commit_message re-enabled at .+; quality counting restarts from here\.\n$/u);
    const again = await run(["inner", "resume", "commit_message"]);
    expect(again.code).toBe(0);
    expect(again.out).toBe("commit_message is not suspended; nothing to do.\n");

    // Counting restarted: the window is empty although the ledger keeps the three earlier calls.
    const view = JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent;
    const cm = view.tasks.find((t: { task: string }) => t.task === "commit_message");
    expect(cm).toMatchObject({ suspended: false, total_calls: 3 });
    expect(cm.window).toMatchObject({ calls: 0, rejected: 0, rejection_rate: null });
    expect((await run(["inner", "test", "commit_message"], { innerBackend: good })).code).toBe(0);
    expect(good.requests).toHaveLength(1);
  });
});
