import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type AuthResult, ClaudeAdapter, CodexAdapter } from "../adapters/index.js";
import { createLedger, type Ledger, openLedger, type RunState } from "../ledger/index.js";
import { acquireDataDirLock, LOCK_FILE_NAME } from "../lock/index.js";
import { canonicalScopeJson, parsePrivilegedScope, privilegedScopeHash } from "../policy/index.js";
import { defaultAdapters } from "./doctor.js";
import { applyOperatorRequests, HELP, listPendingCancels, listPendingDecisions, main } from "./index.js";
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
    // T6.3: `capacity` (LLD §16.3) is the one additive key since M1.
    expect(Object.keys(j).sort()).toEqual(["adapters", "capacity", "checks", "ok", "schema_version"]);
    expect(j.ok).toBe(true);
    expect(j.checks.map((c: { id: string }) => c.id)).toEqual([
      "node",
      "git",
      "config",
      "data_dir",
      "ledger",
      "lock",
      "gc",
      "orphans",
    ]);
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
    ).toEqual(["fake", "claude", "codex", "grok"]);
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

  it("skips providers disabled in config without probing them and without affecting the exit code", async () => {
    const script = path.join(tmp, "fake-codex-probed.mjs");
    const marker = path.join(tmp, "probed");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(2);`,
    );
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(
      configPath,
      JSON.stringify({ ...raw, providers: { codex: { enabled: false }, "claude-code": { enabled: false } } }),
    );
    const registry = new AdapterRegistry()
      .register(new FakeAdapter())
      .register(new CodexAdapter({ executable: process.execPath, launcherArgs: [script] }))
      .register(new ClaudeAdapter({ binaryPath: path.join(tmp, "no-such-claude") }));
    const r = await run(["doctor", "--json", ...cfg()], { adapters: registry });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(true);
    const by = Object.fromEntries(j.adapters.map((a: { id: string }) => [a.id, a]));
    expect(by.fake.status).toBe("ok");
    for (const id of ["codex", "claude"]) {
      expect(by[id]).toMatchObject({ status: "skip", version_gate: null });
      expect(by[id].note).toContain("disabled in config");
    }
    expect(existsSync(marker)).toBe(false);
    const text = (await run(["doctor", ...cfg()], { adapters: registry })).out;
    expect(text).toContain("[skip] Codex (real provider): disabled in config");
    expect(text).toContain("Result: OK");
  });

  it("still probes a provider that is explicitly enabled or unlisted", async () => {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...raw, providers: { codex: { enabled: true } } }));
    const registry = new AdapterRegistry().register(new CodexAdapter({ pathEnv: "" }));
    const j = JSON.parse((await run(["doctor", "--json", ...cfg()], { adapters: registry })).out);
    expect(j.adapters[0]).toMatchObject({ id: "codex", status: "warn" });
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
        "commits",
        "created_at",
        "failure_code",
        "failure_detail",
        "finished_at",
        "git_policy_violations",
        "id",
        "meta_session_id",
        "provider",
        "pushes",
        "started_at",
        "state",
        "trust_profile",
        "updated_at",
      ].sort(),
    );
    expect(j.run.commits).toEqual([]);
    expect(j.run.pushes).toEqual([]);
    expect(j.run.cancel_requested).toBe(false);
    expect(j.run.git_policy_violations).toBe(0);
    expect(j.events).toEqual([]);
    const human = await run(["runs", "show", id, ...cfg()]);
    expect(human.out).toContain(`Run ${id}`);
    const missing = await run(["runs", "show", "run_nope", "--json", ...cfg()]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).error.code).toBe("NOT_FOUND");
    expect((await run(["runs", "show", ...cfg()])).code).toBe(2);
  });
});

/** A privileged meta-session (T3.3): first run AWAITING_APPROVAL with its PENDING row, optionally a covered later run. */
describe("runs show flags Git policy violations (T9.5, FR-GIT-03, BR-27)", () => {
  it("prints a VIOLATION line, the count in --json, and the LEASED snapshot without its ref list", async () => {
    const s = seed(["SUCCEEDED"]);
    const id = s.ids[0] as string;
    s.ledger.appendRunEvent({
      runId: id,
      type: "git_ref_snapshot",
      payload: { v: 1, phase: "leased", digest: "d", ref_count: 2, refs: [["refs/heads/secret-name", "a".repeat(40)]] },
    });
    s.ledger.appendRunEvent({
      runId: id,
      type: "git_policy_violation",
      payload: { v: 1, violation_count: 1, violations: [{ scope: "other", kind: "created", ref: "refs/tags/x" }] },
    });
    s.close();
    const j = JSON.parse((await run(["runs", "show", id, "--json", ...cfg()])).out);
    expect(j.run.git_policy_violations).toBe(1);
    const human = (await run(["runs", "show", id, ...cfg()])).out;
    expect(human).toContain("git policy:  VIOLATION (1 git_policy_violation event(s)");
    expect(human).toContain('"refs_listed":1');
    expect(human).not.toContain("secret-name");
    expect(human).toContain("refs/tags/x");
  });
});

describe("runs show lists harness and backing provider (T4.6, FR-ADP-10)", () => {
  it("shows both in text and --json, and omits usage when none was reported", async () => {
    const s = seed(["SUCCEEDED", "SUCCEEDED"]);
    const id = s.ids[0] as string;
    s.ledger.insertUsageObservation({
      runId: id,
      provider: "fake",
      harness: "fake",
      backingProvider: "backing-x",
      model: "m-a",
      source: "provider_reported",
      metrics: { input_tokens: 7 },
    });
    s.close();
    const j = JSON.parse((await run(["runs", "show", id, "--json", ...cfg()])).out);
    expect(j.usage).toEqual([
      expect.objectContaining({
        harness: "fake",
        backing_provider: "backing-x",
        model: "m-a",
        metrics: { input_tokens: 7 },
      }),
    ]);
    const human = (await run(["runs", "show", id, ...cfg()])).out;
    expect(human).toContain("harness fake  backing provider backing-x  model m-a");
    const none = JSON.parse((await run(["runs", "show", s.ids[1] as string, "--json", ...cfg()])).out);
    expect(none.usage).toBeUndefined();
  });
});

function seedPrivileged(opts: { approved?: boolean; realHash?: boolean } = {}) {
  const db = openLedger(dataDir);
  const ledger = createLedger(db);
  const s = ledger.createMetaSession({ objective: "o" });
  const scope = {
    files: { access: "worktree" },
    shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
    network: { mode: "off" },
    repository_config: { mode: "disabled" },
    bypass: true,
  };
  const parsed = parsePrivilegedScope(scope);
  if (!parsed.ok) throw new Error("bad fixture");
  // `realHash`: the v2 hash LLD §3.1 defines; otherwise a placeholder that every hash check rejects.
  const hash = opts.realHash
    ? privilegedScopeHash({ clientId: "c1", metaSessionId: s.id, scope: parsed.scope })
    : "f".repeat(64);
  const approvalId = ledger.newApprovalId();
  const snapshot = { name: "privileged", privilegedScope: { scope, scopeHash: hash, approvalId } };
  const mk = (state: RunState, i: number) =>
    ledger.createRun({
      metaSessionId: s.id,
      state,
      trustProfile: "privileged",
      policySnapshot: snapshot,
      request: {},
      requestHash: `p${i}`,
      clientId: "c1",
      provider: "fake",
    }).id;
  const first = mk(opts.approved ? "SUCCEEDED" : "AWAITING_APPROVAL", 0);
  ledger.createApproval({
    id: approvalId,
    runId: first,
    scopeJson: opts.realHash ? canonicalScopeJson(parsed.scope) : JSON.stringify(scope),
    scopeHash: hash,
  });
  const ids = [first];
  if (opts.approved) {
    ledger.decideApproval({ id: approvalId, status: "APPROVED", decidedBy: "op" });
    ids.push(mk("QUEUED", 1));
  }
  return { ids, approvalId, ledger, close: () => db.close() };
}

describe("privileged runs on the operator CLI (T3.3, LLD §3.1)", () => {
  it("runs show prints the scope, bypass, scope hash, decision and the runs the approval covers", async () => {
    const s = seedPrivileged({ approved: true });
    s.close();
    for (const id of s.ids) {
      const j = JSON.parse((await run(["runs", "show", id, "--json", ...cfg()])).out);
      expect(Object.keys(j)).toEqual(["schema_version", "run", "events", "approval"]);
      expect(j.approval).toMatchObject({
        id: s.approvalId,
        status: "APPROVED",
        requested_by_run: s.ids[0],
        decided_by: "op",
        bypass: true,
        scope_hash: "f".repeat(64),
        scope: { shell: { mode: "allowlist", allowlist: [["npm", "test"]] } },
      });
      expect(j.approval.covered_runs.map((r: { id: string }) => r.id)).toEqual(s.ids);
    }
    const human = (await run(["runs", "show", s.ids[1] as string, ...cfg()])).out;
    expect(human).toContain(`Approval ${s.approvalId}`);
    expect(human).toContain("bypass:      yes");
    expect(human).toContain(`scope hash:  ${"f".repeat(64)}`);
    expect(human).toContain('"allowlist":[["npm","test"]]');
    expect(human).toContain(`covers runs: ${s.ids[0]} (SUCCEEDED), ${s.ids[1]} (QUEUED)`);
  });

  it("runs cancel of a run awaiting approval closes its PENDING row DENIED by the operator (Q-15)", async () => {
    const s = seedPrivileged();
    const id = s.ids[0] as string;
    const j = JSON.parse((await run(["runs", "cancel", id, "--json", ...cfg()])).out);
    expect(j).toMatchObject({ outcome: "cancelled", state: "CANCELLED" });
    expect(s.ledger.getApproval(s.approvalId)).toMatchObject({ status: "DENIED", decided_by: "tester" });
    s.close();
  });

  it("the daemon applying an operator cancel closes the row DENIED by the requester", async () => {
    const s = seedPrivileged();
    const id = s.ids[0] as string;
    const lock = acquireDataDirLock(dataDir);
    try {
      expect(JSON.parse((await run(["runs", "cancel", id, "--json", ...cfg()])).out).outcome).toBe("requested");
    } finally {
      lock.release();
    }
    const db = openLedger(dataDir);
    try {
      const ledger = createLedger(db);
      const applied: [string, string | undefined, string | undefined][] = [];
      await applyOperatorRequests(db, ledger, {
        cancel: async (runId, reason, decidedBy) => {
          applied.push([runId, reason, decidedBy]);
          return "CANCELLED";
        },
      });
      expect(applied).toEqual([[id, "operator_cancel", "tester"]]);
    } finally {
      db.close();
      s.close();
    }
  });
});

describe("approve/deny (T3.4, FR-OPS-02, FRD WF-7, LLD §3.1 Approve)", () => {
  const eventTypes = (ledger: Ledger, id: string) => ledger.listRunEvents(id).map((e) => e.type);
  const DECISION_KEYS = [
    "approval_id",
    "daemon_running",
    "decided_at",
    "decided_by",
    "decision",
    "outcome",
    "request_event_id",
    "run_id",
    "schema_version",
    "scope_hash",
    "state",
  ];

  it("is a top-level command (not `runs approve`) listed in the help", async () => {
    expect(HELP).toContain("approve <run_id>");
    expect(HELP).toContain("deny <run_id>");
    expect((await run(["approve", ...cfg()])).code).toBe(2);
    expect((await run(["deny", "a", "b", ...cfg()])).code).toBe(2);
    const sub = await run(["runs", "approve", "run_x", ...cfg()]);
    expect(sub.code).toBe(2);
    expect(sub.err).toContain("unknown runs subcommand");
  });

  it("without a daemon: approve moves the run to QUEUED (T3) with a decided row; a second decision is refused", async () => {
    const s = seedPrivileged({ realHash: true });
    const id = s.ids[0] as string;
    const r = await run(["approve", id, "--json", ...cfg()]);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(Object.keys(j).sort()).toEqual(DECISION_KEYS);
    const row = s.ledger.getApproval(s.approvalId);
    expect(j).toMatchObject({
      schema_version: 1,
      run_id: id,
      decision: "approve",
      outcome: "approved",
      state: "QUEUED",
      daemon_running: false,
      approval_id: s.approvalId,
      decided_by: "tester",
      decided_at: row?.decided_at,
      scope_hash: row?.scope_hash,
    });
    expect(row).toMatchObject({ status: "APPROVED", decided_by: "tester" });
    expect(s.ledger.getRun(id)?.state).toBe("QUEUED");
    expect(eventTypes(s.ledger, id)).toEqual([
      "operator_decision_requested",
      "approval_decided",
      "state_transition",
      "operator_decision_applied",
    ]);
    const [req, , moved, applied] = s.ledger.listRunEvents(id).map((e) => JSON.parse(e.payload_json));
    expect(req).toEqual({
      decision: "APPROVED",
      approval_id: s.approvalId,
      requested_by: "tester",
      scope_hash: row?.scope_hash,
    });
    expect(moved).toMatchObject({ from: "AWAITING_APPROVAL", to: "QUEUED", rule: "T3", applied_by: "cli_direct" });
    expect(applied).toMatchObject({
      state_after: "QUEUED",
      applied_by: "cli_direct",
      request_event_id: j.request_event_id,
    });

    // A second decision (either way) is refused: exit 1, REFUSED, nothing written.
    for (const cmd of ["approve", "deny"]) {
      const again = await run([cmd, id, "--json", ...cfg()]);
      expect(again.code).toBe(1);
      expect(JSON.parse(again.out).error).toMatchObject({ code: "REFUSED" });
      expect(JSON.parse(again.out).error.message).toContain("QUEUED, not AWAITING_APPROVAL");
    }
    expect(s.ledger.listRunEvents(id)).toHaveLength(4);
    expect(s.ledger.getApproval(s.approvalId)).toEqual(row);
    s.close();
  });

  it("without a daemon: deny ends the run CANCELLED (T19) with a DENIED row (timestamp, OS user)", async () => {
    const s = seedPrivileged({ realHash: true });
    const id = s.ids[0] as string;
    const r = await run(["deny", id, ...cfg()]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("denied (no daemon was running; applied directly)");
    const row = s.ledger.getApproval(s.approvalId);
    expect(row).toMatchObject({ status: "DENIED", decided_by: "tester" });
    expect(row?.decided_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const after = s.ledger.getRunRecord(id);
    expect(after).toMatchObject({ state: "CANCELLED", worktree_path: null, pid: null });
    expect(after?.finished_at).not.toBeNull();
    const moved = JSON.parse(s.ledger.listRunEvents(id)[2]?.payload_json ?? "{}");
    expect(moved).toMatchObject({ from: "AWAITING_APPROVAL", to: "CANCELLED", rule: "T19", reason: "operator_deny" });
    expect((await run(["approve", id, ...cfg()])).code).toBe(1);
    expect(s.ledger.getApproval(s.approvalId)).toEqual(row);
    s.close();
  });

  it("with a daemon: only the record is written; a second decision is refused; the daemon applies it once", async () => {
    const s = seedPrivileged({ realHash: true });
    const id = s.ids[0] as string;
    const lock = acquireDataDirLock(dataDir);
    let requestedAt: string;
    try {
      const j = JSON.parse((await run(["approve", id, "--json", ...cfg()])).out);
      expect(j).toMatchObject({ outcome: "requested", state: "AWAITING_APPROVAL", daemon_running: true });
      requestedAt = j.decided_at;
      expect(s.ledger.getRun(id)?.state).toBe("AWAITING_APPROVAL");
      expect(s.ledger.getApproval(s.approvalId)?.status).toBe("PENDING");
      expect(eventTypes(s.ledger, id)).toEqual(["operator_decision_requested"]);
      const second = await run(["deny", id, "--json", ...cfg()]);
      expect(second.code).toBe(1);
      expect(JSON.parse(second.out).error.message).toContain("already recorded");
      expect(eventTypes(s.ledger, id)).toEqual(["operator_decision_requested"]);
      // A cancel is still accepted as its own record (Q-15 behaviour unchanged).
      expect(JSON.parse((await run(["runs", "cancel", id, "--json", ...cfg()])).out).outcome).toBe("requested");
    } finally {
      lock.release();
    }
    const db = openLedger(dataDir);
    try {
      const ledger = createLedger(db);
      const cancelled: string[] = [];
      const applied = await applyOperatorRequests(db, ledger, {
        cancel: async (runId) => {
          cancelled.push(runId);
          return "CANCELLED";
        },
      });
      expect(applied).toMatchObject([
        { kind: "decision", runId: id, stateAfter: "QUEUED" },
        { kind: "cancel", runId: id, stateAfter: "CANCELLED" },
      ]);
      expect(ledger.getApproval(s.approvalId)).toMatchObject({
        status: "APPROVED",
        decided_by: "tester",
        decided_at: requestedAt,
      });
      expect(listPendingDecisions(db)).toEqual([]);
      expect(await applyOperatorRequests(db, ledger, { cancel: async () => "CANCELLED" })).toEqual([]);
    } finally {
      db.close();
      s.close();
    }
  });

  it("a decision recorded for the daemon that no longer applies is rejected, not applied", async () => {
    const s = seedPrivileged({ realHash: true });
    const id = s.ids[0] as string;
    const lock = acquireDataDirLock(dataDir);
    try {
      await run(["approve", id, ...cfg()]);
    } finally {
      lock.release();
    }
    // The orchestrator cancels before the daemon applies the record (FRD §4.3, Q-15: the row is closed DENIED).
    s.ledger.immediate(() => {
      const r = s.ledger.getRunRecord(id);
      if (!r) throw new Error("no run");
      s.ledger.decideApproval({ id: s.approvalId, status: "DENIED", decidedBy: "cancel_run" });
      s.ledger.casRunState({ runId: id, from: r.state, to: "CANCELLED", expectedVersion: r.version, payload: {} });
    });
    const db = openLedger(dataDir);
    try {
      const ledger = createLedger(db);
      const out = await applyOperatorRequests(db, ledger, { cancel: async () => "CANCELLED" });
      expect(out).toMatchObject([{ kind: "decision", runId: id, stateAfter: null }]);
      expect(out[0]?.error).toContain("CANCELLED, not AWAITING_APPROVAL");
      expect(eventTypes(ledger, id).at(-1)).toBe("operator_decision_rejected");
      expect(ledger.getApproval(s.approvalId)?.status).toBe("DENIED");
    } finally {
      db.close();
      s.close();
    }
  });

  it("refuses an unknown id, a non-privileged run, a later run reusing an approval and a hash mismatch, writing nothing", async () => {
    const plain = seed(["QUEUED"]);
    plain.close();
    const approved = seedPrivileged({ approved: true, realHash: true });
    approved.close();
    const tampered = seedPrivileged(); // placeholder hash: fails every check
    tampered.close();
    const cases: [string, string, string][] = [
      ["run_missing", "NOT_FOUND", "unknown run"],
      [plain.ids[0] as string, "REFUSED", "not privileged"],
      [approved.ids[1] as string, "REFUSED", "approve and deny act only on the run that requested an approval"],
      [approved.ids[0] as string, "REFUSED", "SUCCEEDED, not AWAITING_APPROVAL"],
      [tampered.ids[0] as string, "REFUSED", "scope hash check failed"],
    ];
    const snapshot = () => {
      const db = openLedger(dataDir);
      try {
        return JSON.stringify([
          db.prepare("SELECT id, state, version FROM run ORDER BY id").all(),
          db.prepare("SELECT * FROM approval ORDER BY id").all(),
          db.prepare("SELECT COUNT(*) AS n FROM run_event").get(),
        ]);
      } finally {
        db.close();
      }
    };
    const before = snapshot();
    for (const [id, code, text] of cases) {
      for (const cmd of ["approve", "deny"]) {
        const r = await run([cmd, id, "--json", ...cfg()]);
        expect(r.code, `${cmd} ${id}`).toBe(1);
        expect(JSON.parse(r.out).error.code).toBe(code);
        expect(JSON.parse(r.out).error.message).toContain(text);
      }
    }
    const human = await run(["approve", tampered.ids[0] as string, ...cfg()]);
    expect(human.code).toBe(1);
    expect(human.err).toContain("nothing changed");
    expect(snapshot()).toBe(before);
    // A pending cancel also blocks a decision.
    const lock = acquireDataDirLock(dataDir);
    try {
      const fresh = seedPrivileged({ realHash: true });
      fresh.close();
      await run(["runs", "cancel", fresh.ids[0] as string, ...cfg()]);
      const r = await run(["approve", fresh.ids[0] as string, ...cfg()]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("a cancel request");
    } finally {
      lock.release();
    }
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

describe("doctor profile overrides (T3.2)", () => {
  const fakeOnly = () => new AdapterRegistry().register(new FakeAdapter());

  it("lists applied overrides, warning on a loosening, and shows none by default", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [path.join(tmp, "repos")],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        profiles: {
          "edit-untrusted": { shell_allowlist: ["npm test"] },
          "inspect-untrusted": { network: "off" },
        },
      }),
    );
    const j = JSON.parse((await run(["doctor", "--json", ...cfg()], { adapters: fakeOnly() })).out);
    const c = j.checks.find((x: { id: string }) => x.id === "profiles");
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("edit-untrusted.shellAllowlist [] -> [npm test] (loosen)");
    expect(j.ok).toBe(true);
    const text = (await run(["doctor", ...cfg()], { adapters: fakeOnly() })).out;
    expect(text).toContain("Profile overrides: edit-untrusted.shellAllowlist");
  });
});

describe("doctor privileged approval (owner decision 22, ADR-0019)", () => {
  const fakeOnly = () => new AdapterRegistry().register(new FakeAdapter());
  const writeClients = (clients: Record<string, unknown>[]) =>
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [path.join(tmp, "repos")],
        mcp_clients: clients,
      }),
    );

  it("warns, naming each client whose privileged requests skip approve; no line by default", async () => {
    writeClients([
      { id: "ops", max_trust_profile: "privileged" },
      { id: "zemdregon", max_trust_profile: "privileged", privileged_approval: "not_required" },
      { id: "lab", max_trust_profile: "privileged", privileged_approval: "not_required" },
    ]);
    const j = JSON.parse((await run(["doctor", "--json", ...cfg()], { adapters: fakeOnly() })).out);
    const c = j.checks.find((x: { id: string }) => x.id === "privileged_approval");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/^not required for clients zemdregon, lab: /);
    expect(c.detail).not.toContain("ops");
    expect(j.ok).toBe(true);
    const text = (await run(["doctor", ...cfg()], { adapters: fakeOnly() })).out;
    expect(text).toMatch(/\[warn\] Privileged approval: not required for clients zemdregon, lab/);

    writeClients([{ id: "ops", max_trust_profile: "privileged", privileged_approval: "required" }]);
    const d = JSON.parse((await run(["doctor", "--json", ...cfg()], { adapters: fakeOnly() })).out);
    expect(d.checks.map((x: { id: string }) => x.id)).not.toContain("privileged_approval");
  });
});

describe("doctor inner-agent shared subscription (T11.5, FR-INN-15)", () => {
  const fakeOnly = () => new AdapterRegistry().register(new FakeAdapter());
  const writeInner = (backend: Record<string, unknown>) =>
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [path.join(tmp, "repos")],
        mcp_clients: [{ id: "ops", max_trust_profile: "privileged" }],
        inner_agent: {
          enabled: true,
          backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "m", ...backend },
        },
      }),
    );

  it("warns when the backend shares a provider's subscription; no line otherwise", async () => {
    writeInner({ shares_subscription_with: "claude-code" });
    const j = JSON.parse((await run(["doctor", "--json", ...cfg()], { adapters: fakeOnly() })).out);
    const c = j.checks.find((x: { id: string }) => x.id === "inner_shared_subscription");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/shares the claude-code subscription: its calls consume claude-code capacity/);
    expect(j.ok).toBe(true);
    const text = (await run(["doctor", ...cfg()], { adapters: fakeOnly() })).out;
    expect(text).toMatch(/\[warn\] Inner agent subscription: /);

    writeInner({});
    const d = JSON.parse((await run(["doctor", "--json", ...cfg()], { adapters: fakeOnly() })).out);
    expect(d.checks.map((x: { id: string }) => x.id)).not.toContain("inner_shared_subscription");
  });
});
