/**
 * T3.10 verification stage end to end (FR-EXE-08, FRD T11, T14, BR-16, §4.3, V7; FR-TEL-03, NFR-SEC-01; LLD §8.1):
 * the fake adapter plays the agent, then the lifecycle runs `verification_commands` as argv arrays in the run worktree.
 * Real Git in temporary directories; no provider CLI, login, network or credential. The crash/restart case lives in
 * `src/reconcile/reconcile.test.ts` ("controller crash during VERIFYING").
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeAdapterOptions } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type ResolvedProfile,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { detectOuterSandbox, findOnPath, groupAlive, type OuterSandboxAvailability } from "../exec/index.js";
import { GIT_POLICY_VIOLATION_EVENT, type ViolationEntry } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { LifecycleError, RunLifecycle, startVerification, VERIFICATION_OUTPUT_CAP_BYTES } from "./index.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const NODE = process.execPath;
/** An invented canary in the `sk-` token shape the default redactor knows; it is not a real credential. */
const CANARY_TOKEN = "sk-switchboardCanaryT310notarealkey0000";

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/**
 * The fake adapter with extra allowlisted names and adapter-declared variables in its invocation, to show that the
 * verification environment drops `GIT_*`, signing/agent variables and every adapter-declared variable.
 */
class WideEnvAdapter extends FakeAdapter {
  override compile(req: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    const inv = super.compile(req, profile);
    if ("ineligible" in inv) return inv;
    return {
      ...inv,
      envAllowlist: [...inv.envAllowlist, "HOME", "GIT_DIR", "SSH_AUTH_SOCK", "GNUPGHOME"],
      env: { ...inv.env, SWITCHBOARD_TOOL_TOKEN: "adapter-declared-value" },
    };
  }
}

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(
  opts: {
    adapter?: FakeAdapter;
    fake?: FakeAdapterOptions;
    baseEnv?: Record<string, string>;
    confinedVerification?: boolean;
    outerSandboxRequiredProfiles?: readonly string[];
    outerSandbox?: OuterSandboxAvailability | undefined;
  } = {},
): RunLifecycle {
  const ids = createIdGenerator();
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const adapter = opts.adapter ?? new FakeAdapter({ scenario: "success", timeouts: PATIENT, ...opts.fake });
  const lc = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
    ...(opts.confinedVerification !== undefined ? { confinedVerification: opts.confinedVerification } : {}),
    ...(opts.outerSandboxRequiredProfiles ? { outerSandboxRequiredProfiles: opts.outerSandboxRequiredProfiles } : {}),
    ...(opts.outerSandbox ? { outerSandbox: opts.outerSandbox } : {}),
  });
  lc.start();
  lifecycle = lc;
  return lc;
}

async function submit(
  lc: RunLifecycle,
  verificationCommands: string[][],
  trustProfile: TrustProfile = "edit-untrusted",
) {
  return lc.submit({
    clientId: "c",
    objective: "do the work",
    workspace: repo,
    trustProfile,
    provider: "fake",
    verificationCommands,
  });
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const transitions = (runId: string) =>
  events(runId)
    .filter((e) => e.type === "state_transition")
    .map((e) => `${String(e.p.to)}:${String(e.p.rule)}`);
const terminalPayload = (runId: string) =>
  events(runId)
    .filter((e) => e.type === "state_transition")
    .at(-1)?.p ?? {};

interface ReportCommand {
  index: number;
  argv: string[];
  outcome: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
}
async function report(
  runId: string,
): Promise<{ v: number; outcome: string; commands: ReportCommand[]; confined?: boolean }> {
  const rows = ledger.listArtifactsForRun(runId).filter((a) => a.kind === "test_report");
  expect(rows).toHaveLength(1);
  const row = rows[0] as { sha256: string; media_type: string };
  expect(row.media_type).toBe("application/json");
  return JSON.parse((await artifacts.get(row.sha256)).toString("utf8"));
}
const worktreeOf = (runId: string) => ledger.getRunRecord(runId)?.worktree_path as string;

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-verify-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("verification stage (T3.10, FR-EXE-08, FRD T11/T14, BR-16)", () => {
  it("pass: T11, T14, SUCCEEDED; results in a test_report artifact and the terminal record", async () => {
    const lc = makeLifecycle();
    const { runId } = await submit(lc, [
      [NODE, "-e", "process.stdout.write('first ok')"],
      [NODE, "-e", "process.stderr.write('second ok'); require('fs').writeFileSync('built.txt', 'x')"],
    ]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("SUCCEEDED");
    expect(done.failure_code).toBeNull();
    expect(transitions(runId).slice(-3)).toEqual(["VERIFYING:T11", "FINALIZING:T14", "SUCCEEDED:T15"]);
    const rep = await report(runId);
    expect(rep).toMatchObject({ v: 1, outcome: "passed" });
    expect(rep.commands.map((c) => [c.index, c.outcome, c.exit_code])).toEqual([
      [0, "passed", 0],
      [1, "passed", 0],
    ]);
    expect(rep.commands[0]?.stdout).toBe("first ok");
    expect(rep.commands[1]?.stderr).toBe("second ok");
    // Ran in the run's worktree (cwd), and what it wrote is part of the post-run checkpoint like the agent's edits.
    expect(existsSync(path.join(worktreeOf(runId), "built.txt"))).toBe(true);
    expect(existsSync(path.join(repo, "built.txt"))).toBe(false);
    const fin = terminalPayload(runId);
    expect(fin.verification).toEqual([
      expect.objectContaining({ index: 0, outcome: "passed", exit_code: 0 }),
      expect.objectContaining({ index: 1, outcome: "passed", exit_code: 0 }),
    ]);
    expect((fin.artifacts as Record<string, string>).test_report).toMatch(/^art_/);
    expect(fin.summary).toBeDefined(); // the agent's own result is kept (BR-16)
    // FR-TEL-03: no command output in any run event.
    expect(JSON.stringify(events(runId))).not.toContain("first ok");
  }, 60_000);

  it("fail: a non-zero exit ends FAILED/TEST_FAILURE, later commands are not run, the report is stored", async () => {
    const lc = makeLifecycle();
    const { runId } = await submit(lc, [
      [NODE, "-e", "console.error('assertion failed'); process.exit(3)"],
      [NODE, "-e", "require('fs').writeFileSync('should-not-exist.txt', 'x')"],
    ]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("TEST_FAILURE");
    expect(transitions(runId).slice(-3)).toEqual(["VERIFYING:T11", "FINALIZING:T14", "FAILED:T16"]);
    const rep = await report(runId);
    expect(rep.outcome).toBe("failed");
    expect(rep.commands.map((c) => [c.outcome, c.exit_code])).toEqual([
      ["failed", 3],
      ["not_run", null],
    ]);
    expect(rep.commands[0]?.stderr).toContain("assertion failed");
    expect(existsSync(path.join(worktreeOf(runId), "should-not-exist.txt"))).toBe(false);
    expect(terminalPayload(runId).verification).toEqual([
      expect.objectContaining({ index: 0, outcome: "failed", exit_code: 3 }),
      expect.objectContaining({ index: 1, outcome: "not_run" }),
    ]);
    expect(terminalPayload(runId).summary).toBeDefined();
  }, 60_000);

  it("a command that cannot be started is a failure (TEST_FAILURE), not a controller error", async () => {
    const lc = makeLifecycle();
    const { runId } = await submit(lc, [[path.join(root, "no-such-binary")]]);
    const done = await lc.waitForTerminal(runId);
    expect(done.failure_code).toBe("TEST_FAILURE");
    expect((await report(runId)).commands[0]?.outcome).toBe("error");
  }, 60_000);

  it("timeout: a hanging command's group is killed at the run's wall-clock bound, TEST_FAILURE", async () => {
    const lc = makeLifecycle({ fake: { timeouts: { wallClockMs: 3_000, idleMs: 3_000, killGraceMs: 200 } } });
    const pidFile = path.join(root, "hang.pid");
    const { runId } = await submit(lc, [
      [
        NODE,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
    ]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("TEST_FAILURE");
    expect((await report(runId)).commands[0]).toMatchObject({ outcome: "timeout", exit_code: null });
    expect(groupAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  }, 60_000);

  it("output is redacted before it is stored, and bounded with a truncation marker", async () => {
    const lc = makeLifecycle();
    const big = VERIFICATION_OUTPUT_CAP_BYTES + 4096;
    const { runId } = await submit(lc, [
      [NODE, "-e", `console.log('token: ${CANARY_TOKEN}'); console.error('password=${CANARY_TOKEN}')`],
      [NODE, "-e", `process.stdout.write('y'.repeat(${big}))`],
    ]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("SUCCEEDED");
    const rep = await report(runId);
    expect(rep.commands[0]?.stdout).toContain("[REDACTED]");
    expect(rep.commands[0]?.stderr).toContain("[REDACTED]");
    expect(rep.commands[1]?.stdout_truncated).toBe(true);
    expect(rep.commands[1]?.stdout).toContain("[switchboard: output truncated");
    expect(rep.commands[1]?.stdout.length).toBeLessThan(VERIFICATION_OUTPUT_CAP_BYTES + 200);
    // Nowhere on disk or in the ledger (NFR-SEC-01).
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else files.push(path.join(d, e.name));
      }
    };
    walk(path.join(dataDir, "artifacts"));
    for (const f of files) expect(readFileSync(f, "latin1")).not.toContain(CANARY_TOKEN);
    const dbDump = (db.prepare("SELECT payload_json FROM run_event").all() as { payload_json: string }[])
      .map((r) => r.payload_json)
      .join("\n");
    expect(dbDump).not.toContain(CANARY_TOKEN);
  }, 60_000);

  it("argv only, no shell: shell metacharacters in an argument are passed literally", async () => {
    const script = path.join(root, "echo-argv.mjs");
    writeFileSync(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n",
    );
    const lc = makeLifecycle();
    const tricky = ["a; touch pwned1", "$(touch pwned2)", "`touch pwned3`", "| touch pwned4", "*", "$HOME"];
    const { runId } = await submit(lc, [[NODE, script, ...tricky]]);
    expect((await lc.waitForTerminal(runId)).state).toBe("SUCCEEDED");
    const wt = worktreeOf(runId);
    expect(JSON.parse(readFileSync(path.join(wt, "argv.json"), "utf8"))).toEqual(tricky);
    for (const f of ["pwned1", "pwned2", "pwned3", "pwned4"]) {
      expect(existsSync(path.join(wt, f))).toBe(false);
      expect(existsSync(path.join(root, f))).toBe(false);
    }
  }, 60_000);

  it("environment: only the run's allowlist; no canary, GIT_*, signing/agent or adapter variable", async () => {
    const baseEnv = {
      PATH: process.env.PATH ?? "",
      HOME: root,
      SB_T310_CANARY: CANARY_TOKEN,
      GIT_DIR: "/nonexistent",
      SSH_AUTH_SOCK: "/tmp/not-an-agent.sock",
      GNUPGHOME: "/tmp/not-a-keyring",
    };
    const lc = makeLifecycle({ adapter: new WideEnvAdapter({ scenario: "success", timeouts: PATIENT }), baseEnv });
    const { runId } = await submit(lc, [
      [NODE, "-e", "require('fs').writeFileSync('env.json', JSON.stringify(Object.keys(process.env).sort()))"],
    ]);
    expect((await lc.waitForTerminal(runId)).state).toBe("SUCCEEDED");
    const names = JSON.parse(readFileSync(path.join(worktreeOf(runId), "env.json"), "utf8")) as string[];
    // macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts (T4.10); it is not the controller's.
    expect(names.filter((n) => n !== "__CF_USER_TEXT_ENCODING")).toEqual(["HOME", "PATH"]);
  }, 60_000);

  it("Git-write denial holds in VERIFYING: a verification commit is flagged and kept off the run branch", async () => {
    const lc = makeLifecycle();
    const { runId } = await submit(lc, [
      [
        "git",
        "-c",
        "user.name=Verifier",
        "-c",
        "user.email=v@example.test",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "sneaky",
      ],
    ]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("SUCCEEDED"); // BR-27: the violation never changes the outcome
    const violations = events(runId)
      .filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT)
      .flatMap((e) => e.p.violations as ViolationEntry[]);
    expect(violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ scope: "run_branch", kind: "moved" })]),
    );
    const pre = ledger.getRunCheckpointCommit(runId, "pre") as string;
    const post = ledger.getRunCheckpointCommit(runId, "post") as string;
    // The run branch ends at the controller's checkpoint, which descends from `pre` and never from "sneaky".
    expect(g(repo, "rev-parse", `refs/heads/${done.branch}`)).toBe(post);
    g(repo, "merge-base", "--is-ancestor", pre, post);
    expect(g(repo, "log", "--format=%s", `refs/heads/${done.branch}`)).not.toContain("sneaky");
    // Ref check (and restore) happens after VERIFYING, before the checkpoint.
    const order = events(runId).map((e) => (e.type === "state_transition" ? `to:${String(e.p.to)}` : e.type));
    expect(order.indexOf("to:VERIFYING")).toBeLessThan(order.indexOf(GIT_POLICY_VIOLATION_EVENT));
    expect(order.indexOf(GIT_POLICY_VIOLATION_EVENT)).toBeLessThan(order.indexOf("checkpoint"));
  }, 60_000);

  it("cancel during VERIFYING kills the command's group and ends CANCELLED via FINALIZING (FRD §4.3)", async () => {
    const lc = makeLifecycle();
    const pidFile = path.join(root, "verify.pid");
    const { runId } = await submit(lc, [
      [
        NODE,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      [NODE, "-e", "require('fs').writeFileSync('second.txt', 'x')"],
    ]);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(ledger.getRunRecord(runId)?.state).toBe("VERIFYING");
    // The command's process group is recorded on the run for reconciliation (LLD §8).
    await until(() => ledger.getRunRecord(runId)?.pgid === pid);
    expect(await lc.cancel(runId)).toBe("VERIFYING");
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("CANCELLED");
    expect(transitions(runId).slice(-3)).toEqual(["VERIFYING:T11", "FINALIZING:T14", "CANCELLED:T17"]);
    expect(events(runId).find((e) => e.p.to === "FINALIZING")?.p).toMatchObject({ pending: "cancelled" });
    expect(groupAlive(pid)).toBe(false);
    const rep = await report(runId);
    expect(rep.commands.map((c) => c.outcome)).toEqual(["cancelled", "not_run"]);
    expect(existsSync(path.join(worktreeOf(runId), "second.txt"))).toBe(false);
  }, 60_000);

  it("an agent failure skips verification (T13; no VERIFYING, no report)", async () => {
    const lc = makeLifecycle({ fake: { scenario: "task_failure" } });
    const { runId } = await submit(lc, [[NODE, "-e", "require('fs').writeFileSync('ran.txt', 'x')"]]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).not.toBe("TEST_FAILURE");
    expect(transitions(runId)).not.toContain("VERIFYING:T11");
    expect(ledger.listArtifactsForRun(runId).some((a) => a.kind === "test_report")).toBe(false);
  }, 60_000);
});

describe("verification admission (FRD V7, decision 11)", () => {
  it("refuses commands under inspect-untrusted and malformed commands, before any row is written", async () => {
    const lc = makeLifecycle();
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
    await expect(submit(lc, [["npm", "test"]], "inspect-untrusted")).rejects.toBeInstanceOf(LifecycleError);
    await expect(submit(lc, [[]])).rejects.toThrow(/verification/);
    await expect(submit(lc, [[""]])).rejects.toThrow(/verification/);
    expect(count()).toBe(0);
    // An empty list is no verification: T12 as before.
    const { runId } = await submit(lc, []);
    expect((await lc.waitForTerminal(runId)).state).toBe("SUCCEEDED");
    expect(transitions(runId)).not.toContain("VERIFYING:T11");
  }, 60_000);
});

describe("confined verification (T3.11, FR-EXE-08, FR-POL-06, decision 11)", () => {
  it("unconfigured behaviour unchanged: without confined verification, commands run unconfined", async () => {
    const outsideFile = path.join(root, "unconfined-escape.txt");
    const lc = makeLifecycle();
    const { runId } = await submit(lc, [
      [NODE, "-e", `require('node:fs').writeFileSync(${JSON.stringify(outsideFile)}, 'hello')`],
    ]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("SUCCEEDED");
    expect(existsSync(outsideFile)).toBe(true);
  }, 60_000);

  it("fail closed: if confined verification is requested but bubblewrap is unavailable, commands fail closed without running unconfined", async () => {
    const outsideFile = path.join(root, "fail-closed-escape.txt");
    const unavailableSandbox: OuterSandboxAvailability = {
      platform: "linux",
      mechanisms: {
        bubblewrap: {
          mechanism: "bubblewrap",
          available: false,
          path: null,
          version: null,
          detail: "bwrap not on PATH",
        },
        prlimit: { mechanism: "prlimit", available: false, path: null, version: null, detail: "prlimit not on PATH" },
        landlock: {
          mechanism: "landlock",
          available: false,
          path: null,
          version: null,
          detail: "landlock unavailable",
        },
      },
    };
    const lc = makeLifecycle({ confinedVerification: true, outerSandbox: unavailableSandbox });
    const { runId } = await submit(lc, [
      [NODE, "-e", `require('node:fs').writeFileSync(${JSON.stringify(outsideFile)}, 'fail-closed')`],
    ]);
    const done = await lc.waitForTerminal(runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("TEST_FAILURE");
    expect(done.failure_detail).toContain("command 0 error");
    expect(existsSync(outsideFile)).toBe(false);

    const rep = await report(runId);
    expect(rep.commands[0]?.outcome).toBe("error");
    expect(rep.commands[0]?.stderr).toContain("outer sandbox required for verification but bubblewrap is unavailable");
  }, 60_000);

  it("unit: startVerification uses wrapSandbox transform when provided", async () => {
    const wrappedCalls: string[][] = [];
    const v = startVerification({
      commands: [["echo", "hi"]],
      cwd: root,
      envAllowlist: ["PATH"],
      wallClockMs: 10_000,
      confined: true,
      wrapSandbox: (argv, cwd) => {
        wrappedCalls.push([...argv, cwd]);
        return [NODE, "-e", "process.exit(0)"];
      },
    });
    const res = await v.done;
    expect(res.outcome).toBe("passed");
    expect(res.confined).toBe(true);
    expect(wrappedCalls).toEqual([["echo", "hi", root]]);
  });

  const hasBwrap = findOnPath("bwrap", process.env.PATH) !== null;

  describe.skipIf(!hasBwrap)("on this host (bubblewrap on PATH)", () => {
    it("runs verification inside bubblewrap: writes inside worktree pass, writes outside worktree are refused", async () => {
      const bwrapProbe = await detectOuterSandbox().catch(() => undefined);
      if (bwrapProbe?.mechanisms.bubblewrap.available !== true) return;
      const outsideFile = path.join(root, "confined-escape-refused.txt");
      const lc = makeLifecycle({ confinedVerification: true, outerSandbox: bwrapProbe });
      const { runId } = await submit(lc, [
        [NODE, "-e", "require('node:fs').writeFileSync('inside.txt', 'inside-ok')"],
        [NODE, "-e", `require('node:fs').writeFileSync(${JSON.stringify(outsideFile)}, 'escape-blocked')`],
      ]);
      const done = await lc.waitForTerminal(runId);
      expect(done.state).toBe("FAILED");
      expect(done.failure_code).toBe("TEST_FAILURE");
      // The outside file was refused by the kernel (EROFS) and never created on the host:
      expect(existsSync(outsideFile)).toBe(false);

      const wt = worktreeOf(runId);
      expect(existsSync(path.join(wt, "inside.txt"))).toBe(true);

      const rep = await report(runId);
      expect(rep.confined).toBe(true);
      expect(rep.commands.map((c) => c.outcome)).toEqual(["passed", "failed"]);
      expect(rep.commands[1]?.stderr).toMatch(/read-only file system|EROFS/i);
    }, 60_000);

    it("confined verification with outerSandboxRequiredProfiles matching trustProfile", async () => {
      const bwrapProbe = await detectOuterSandbox().catch(() => undefined);
      if (bwrapProbe?.mechanisms.bubblewrap.available !== true) return;
      const outsideFile = path.join(root, "profile-confined-escape.txt");
      const lc = makeLifecycle({
        outerSandboxRequiredProfiles: ["edit-untrusted"],
        outerSandbox: bwrapProbe,
      });
      const { runId } = await submit(
        lc,
        [[NODE, "-e", `require('node:fs').writeFileSync(${JSON.stringify(outsideFile)}, 'profile-escape')`]],
        "edit-untrusted",
      );
      const done = await lc.waitForTerminal(runId);
      expect(done.state).toBe("FAILED");
      expect(done.failure_code).toBe("TEST_FAILURE");
      expect(existsSync(outsideFile)).toBe(false);
      const rep = await report(runId);
      expect(rep.confined).toBe(true);
      expect(rep.commands[0]?.outcome).toBe("failed");
    }, 60_000);
  });
});
