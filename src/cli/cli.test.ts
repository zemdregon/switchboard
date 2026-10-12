import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type AuthResult, ClaudeAdapter, CodexAdapter } from "../adapters/index.js";
import { createLedger, type Ledger, openLedger, type RunState } from "../ledger/index.js";
import { acquireDataDirLock, LOCK_FILE_NAME } from "../lock/index.js";
import { defaultAdapters } from "./doctor.js";
import { applyOperatorRequests, HELP, listPendingCancels, main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cli-")));
  const repos = path.join(tmp, "repos");
  mkdirSync(repos);
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [repos],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeIo(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
    ...extra,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const h = makeIo(extra);
  const code = await main(args, h.io);
  return { code, out: h.out(), err: h.err() };
}
const cfg = () => ["--config", configPath];

function seed(states: RunState[]): { ids: string[]; ledger: Ledger; close: () => void } {
  const db = openLedger(dataDir);
  const ledger = createLedger(db);
  const s = ledger.createMetaSession({ objective: "o" });
  const ids = states.map(
    (state, i) =>
      ledger.createRun({
        metaSessionId: s.id,
        state,
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: `h${i}`,
        clientId: "c1",
        provider: "fake",
      }).id,
  );
  return { ids, ledger, close: () => db.close() };
}

describe("help and command surface (FR-OPS-03)", () => {
  it("lists no login or auth command and rejects unknown commands", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toBe(HELP);
    expect(help.out).not.toMatch(/login|logout|auth/i);
    for (const cmd of ["login", "auth", "logout", "signin"]) {
      const r = await run([cmd]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("unknown command");
    }
  });

  it("prints usage to stderr and exits 2 with no command; rejects unknown flags", async () => {
    expect((await run([])).code).toBe(2);
    const r = await run(["runs", "list", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("switchboard:");
  });

  it("reports usage errors as JSON with --json", async () => {
    const r = await run(["nope", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({
      schema_version: 1,
      error: { code: "USAGE", message: 'unknown command "nope"' },
    });
  });
});

describe("doctor", () => {
  const fakeOnly = () => new AdapterRegistry().register(new FakeAdapter());

  it("passes with the fake adapter and labels it as a test stand-in", async () => {
    const r = await run(["doctor", ...cfg()], { adapters: fakeOnly() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("fake adapter (test stand-in, not a real provider)");
    expect(r.out).toContain("Result: OK");
    expect(r.out.includes(String.fromCharCode(27))).toBe(false); // no colour
  });

  it("has a stable --json schema", async () => {
    const r = await run(["doctor", "--json", ...cfg()], { adapters: fakeOnly() });
    const j = JSON.parse(r.out);
    expect(Object.keys(j).sort()).toEqual(["adapters", "checks", "ok", "schema_version"]);
    expect(j.ok).toBe(true);
    expect(j.checks.map((c: { id: string }) => c.id)).toEqual(["node", "git", "config", "data_dir", "ledger", "lock"]);
    for (const c of j.checks) expect(Object.keys(c).sort()).toEqual(["detail", "id", "label", "status"]);
    expect(j.adapters).toHaveLength(1);
    expect(Object.keys(j.adapters[0]).sort()).toEqual([
      "auth",
      "id",
      "kind",
      "label",
      "note",
      "probe",
      "status",
      "version_gate",
    ]);
    expect(j.adapters[0]).toMatchObject({
      id: "fake",
      kind: "fake",
      status: "ok",
      auth: { state: "OK", instruction: null },
      version_gate: null,
      note: null,
    });
    expect(Object.keys(j.adapters[0].probe).sort()).toEqual(["binary_version", "failed_steps", "ok"]);
  });

  it("fails (exit 1) on an invalid config and skips dependent checks", async () => {
    writeFileSync(configPath, "{}");
    const r = await run(["doctor", "--json", ...cfg()], { adapters: fakeOnly() });
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    const by = Object.fromEntries(j.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    expect(by).toMatchObject({ config: "fail", data_dir: "skip", ledger: "skip", lock: "skip" });
  });

  it("fails on an old Node, a failing probe, and warns (exit 0) on AUTH_REQUIRED", async () => {
    expect((await run(["doctor", ...cfg()], { nodeVersion: "20.1.0" })).code).toBe(1);

    const broken = new AdapterRegistry().register(new FakeAdapter({ script: path.join(tmp, "missing.mjs") }));
    const bad = await run(["doctor", ...cfg()], { adapters: broken });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("probe failed");

    const noAuth = new FakeAdapter();
    noAuth.authPreflight = async (): Promise<AuthResult> => ({
      state: "AUTH_REQUIRED",
      loginCommand: "fake-cli login",
    });
    const warn = await run(["doctor", ...cfg()], { adapters: new AdapterRegistry().register(noAuth) });
    expect(warn.code).toBe(0);
    expect(warn.out).toContain("AUTH_REQUIRED, run natively: fake-cli login");
  });

  it("registers the fake, Claude Code and Codex adapters by default", () => {
    expect(
      defaultAdapters()
        .list()
        .map((a) => a.id),
    ).toEqual(["fake", "claude", "codex"]);
  });

  it("warns, not fails, when real provider CLIs are not installed, and labels real vs fake", async () => {
    const registry = new AdapterRegistry()
      .register(new FakeAdapter())
      .register(new ClaudeAdapter({ binaryPath: path.join(tmp, "no-such-claude") }))
      .register(new CodexAdapter({ pathEnv: "" }));
    const r = await run(["doctor", "--json", ...cfg()], { adapters: registry });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(true);
    const by = Object.fromEntries(j.adapters.map((a: { id: string }) => [a.id, a]));
    expect(by.fake).toMatchObject({ kind: "fake", status: "ok" });
    for (const id of ["claude", "codex"]) {
      expect(by[id]).toMatchObject({ kind: "real", status: "warn", version_gate: null });
      expect(by[id].label).toContain("(real provider)");
      expect(by[id].note).toContain("not installed");
    }
    const text = (await run(["doctor", ...cfg()], { adapters: registry })).out;
    expect(text).toContain("[warn] Claude Code (real provider): probe failed");
    expect(text).toContain("not installed");
  });

  it("fails with an explained ADAPTER_VERSION_UNVERIFIED for an installed Codex (empty manifest range)", async () => {
    const script = path.join(tmp, "fake-codex.mjs");
    writeFileSync(
      script,
      [
        "const a = process.argv.slice(2);",
        'if (a[0] === "--version") console.log("codex-cli 0.1.0");',
        'else if (a[0] === "exec" && a.includes("--help")) console.log("--json --sandbox --ignore-user-config --ignore-rules");',
        "else process.exit(2);",
      ].join("\n"),
    );
    const registry = new AdapterRegistry().register(
      new CodexAdapter({ executable: process.execPath, launcherArgs: [script] }),
    );
    const r = await run(["doctor", "--json", ...cfg()], { adapters: registry });
    expect(r.code).toBe(1);
    const a = JSON.parse(r.out).adapters[0];
    expect(a).toMatchObject({
      id: "codex",
      kind: "real",
      status: "fail",
      probe: { ok: true, binary_version: "codex-cli 0.1.0" },
      auth: { state: "UNKNOWN" },
      version_gate: { eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" },
    });
    expect(a.note).toContain("ADAPTER_VERSION_UNVERIFIED");
    const text = (await run(["doctor", ...cfg()], { adapters: registry })).out;
    expect(text).toContain("[FAIL] Codex (real provider)");
    expect(text).toContain("ineligible until an operator validates this version");
  });

  it("reports the lock holder and a migrated ledger", async () => {
    seed([]).close();
    const lock = acquireDataDirLock(dataDir);
    try {
      const j = JSON.parse((await run(["doctor", "--json", ...cfg()])).out);
      const by = Object.fromEntries(j.checks.map((c: { id: string; status: string; detail: string }) => [c.id, c]));
      expect(by.ledger.status).toBe("ok");
      expect(by.lock.detail).toContain(`pid ${process.pid}`);
    } finally {
      lock.release();
    }
    writeFileSync(path.join(dataDir, LOCK_FILE_NAME), "999999999\n");
    const stale = JSON.parse((await run(["doctor", "--json", ...cfg()])).out);
    expect(stale.checks.find((c: { id: string }) => c.id === "lock").status).toBe("warn");
  });
});

describe("runs list and show (read-only)", () => {
  it("handles a missing ledger without creating one", async () => {
    const r = await run(["runs", "list", ...cfg()]);
    expect(r).toMatchObject({ code: 0, out: "No runs.\n" });
    expect((await run(["runs", "show", "run_X", ...cfg()])).code).toBe(1);
    expect(JSON.parse((await run(["runs", "list", "--json", ...cfg()])).out)).toEqual({ schema_version: 1, runs: [] });
  });

  it("lists newest first with filters, and has a stable --json schema", async () => {
    const s = seed(["QUEUED", "SUCCEEDED", "QUEUED"]);
    s.close();
    const human = await run(["runs", "list", ...cfg()]);
    expect(human.out).toContain("ID");
    expect(human.out.split("\n")[1]).toContain(s.ids[2] as string);

    const j = JSON.parse((await run(["runs", "list", "--json", "--state", "QUEUED", ...cfg()])).out);
    expect(Object.keys(j)).toEqual(["schema_version", "runs"]);
    expect(j.runs.map((r: { id: string }) => r.id)).toEqual([s.ids[2], s.ids[0]]);
    expect(Object.keys(j.runs[0]).sort()).toEqual(
      ["client_id", "created_at", "failure_code", "id", "provider", "state", "trust_profile", "updated_at"].sort(),
    );
    const one = JSON.parse((await run(["runs", "list", "--json", "--limit", "1", ...cfg()])).out);
    expect(one.runs).toHaveLength(1);
    expect((await run(["runs", "list", "--limit", "0", ...cfg()])).code).toBe(2);
  });

  it("shows a run with its events", async () => {
    const s = seed(["QUEUED"]);
    s.close();
    const id = s.ids[0] as string;
    const j = JSON.parse((await run(["runs", "show", id, "--json", ...cfg()])).out);
    expect(Object.keys(j)).toEqual(["schema_version", "run", "events"]);
    expect(Object.keys(j.run).sort()).toEqual(
      [
        "attempt",
        "branch",
        "cancel_requested",
        "client_id",
        "created_at",
        "failure_code",
        "failure_detail",
        "finished_at",
        "id",
        "meta_session_id",
        "provider",
        "started_at",
        "state",
        "trust_profile",
        "updated_at",
      ].sort(),
    );
    expect(j.run.cancel_requested).toBe(false);
    expect(j.events).toEqual([]);
    const human = await run(["runs", "show", id, ...cfg()]);
    expect(human.out).toContain(`Run ${id}`);
    const missing = await run(["runs", "show", "run_nope", "--json", ...cfg()]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).error.code).toBe("NOT_FOUND");
    expect((await run(["runs", "show", ...cfg()])).code).toBe(2);
  });
});

describe("runs cancel", () => {
  it("without a lock holder cancels a queued run directly and records the request", async () => {
    const s = seed(["QUEUED"]);
    const id = s.ids[0] as string;
    const r = await run(["runs", "cancel", id, "--json", ...cfg()]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(Object.keys(j).sort()).toEqual([
      "daemon_running",
      "outcome",
      "request_event_id",
      "run_id",
      "schema_version",
      "state",
    ]);
    expect(j).toMatchObject({ run_id: id, outcome: "cancelled", state: "CANCELLED", daemon_running: false });
    const events = s.ledger.listRunEvents(id);
    expect(events.map((e) => e.type)).toEqual([
      "operator_cancel_requested",
      "state_transition",
      "operator_cancel_applied",
    ]);
    expect(JSON.parse(events[0]?.payload_json ?? "{}")).toMatchObject({ requested_by: "tester" });
    expect(JSON.parse(events[1]?.payload_json ?? "{}")).toMatchObject({ from: "QUEUED", to: "CANCELLED", rule: "T19" });
    s.close();
    expect(
      await run(["runs", "show", id, "--json", ...cfg()]).then((x) => JSON.parse(x.out).run.finished_at),
    ).not.toBeNull();
    // the lock was released afterwards
    acquireDataDirLock(dataDir).release();
    // second cancel is a no-op
    const again = JSON.parse((await run(["runs", "cancel", id, "--json", ...cfg()])).out);
    expect(again.outcome).toBe("already_terminal");
  });

  it("without a lock holder only records the request for an in-flight run", async () => {
    const s = seed(["RUNNING"]);
    const id = s.ids[0] as string;
    const j = JSON.parse((await run(["runs", "cancel", id, "--json", ...cfg()])).out);
    expect(j).toMatchObject({ outcome: "requested", state: "RUNNING", daemon_running: false });
    expect(s.ledger.getRun(id)?.state).toBe("RUNNING");
    s.close();
  });

  it("with a lock holder writes only the operator record and leaves the run untouched", async () => {
    const s = seed(["QUEUED"]);
    const id = s.ids[0] as string;
    const lock = acquireDataDirLock(dataDir);
    try {
      const r = await run(["runs", "cancel", id, "--json", ...cfg()]);
      const j = JSON.parse(r.out);
      expect(j).toMatchObject({ outcome: "requested", state: "QUEUED", daemon_running: true });
      expect(s.ledger.getRun(id)?.state).toBe("QUEUED");
      expect(s.ledger.listRunEvents(id).map((e) => e.type)).toEqual(["operator_cancel_requested"]);
      // idempotent while pending
      const again = JSON.parse((await run(["runs", "cancel", id, "--json", ...cfg()])).out);
      expect(again).toMatchObject({ outcome: "already_requested", request_event_id: j.request_event_id });
      expect(s.ledger.listRunEvents(id)).toHaveLength(1);
      // the daemon's lock is still held by us afterwards
      expect(() => acquireDataDirLock(dataDir, process.pid + 1)).toThrow();
      expect(JSON.parse((await run(["runs", "show", id, "--json", ...cfg()])).out).run.cancel_requested).toBe(true);
    } finally {
      lock.release();
      s.close();
    }
  });

  it("rejects unknown runs and prints human output", async () => {
    const s = seed(["QUEUED"]);
    s.close();
    const bad = await run(["runs", "cancel", "run_missing", ...cfg()]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unknown run");
    const ok = await run(["runs", "cancel", s.ids[0] as string, ...cfg()]);
    expect(ok.out).toContain("cancelled (no daemon was running");
  });
});

describe("applyOperatorRequests (daemon side)", () => {
  it("applies each pending request once through the lifecycle and marks it applied", async () => {
    const s = seed(["QUEUED", "RUNNING", "QUEUED"]);
    const [a, b, c] = s.ids as [string, string, string];
    const lock = acquireDataDirLock(dataDir);
    await run(["runs", "cancel", a, ...cfg()]);
    await run(["runs", "cancel", b, ...cfg()]);
    lock.release();

    const calls: string[] = [];
    const db = openLedger(dataDir);
    const ledger = createLedger(db);
    const fake = {
      async cancel(runId: string): Promise<RunState> {
        calls.push(runId);
        if (runId === b) throw new Error("boom");
        return "CANCELLED";
      },
    };
    expect(listPendingCancels(db).map((p) => p.runId)).toEqual([a, b]);
    const applied = await applyOperatorRequests(db, ledger, fake);
    expect(applied).toMatchObject([
      { runId: a, stateAfter: "CANCELLED" },
      { runId: b, stateAfter: null, error: "boom" },
    ]);
    expect(listPendingCancels(db)).toEqual([]);
    expect(await applyOperatorRequests(db, ledger, fake)).toEqual([]);
    expect(calls).toEqual([a, b]);
    expect(ledger.listRunEvents(a).map((e) => e.type)).toEqual([
      "operator_cancel_requested",
      "operator_cancel_applied",
    ]);
    expect(ledger.listRunEvents(b).at(-1)?.type).toBe("operator_cancel_rejected");
    expect(ledger.listRunEvents(c)).toEqual([]);
    db.close();
    s.close();
  });
});
