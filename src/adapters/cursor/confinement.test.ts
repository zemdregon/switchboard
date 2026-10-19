/**
 * ADR-0059 (T4.48 fix, owner ruling 2026-10-19 06:41 CDT): the Cursor bypass cell runs only inside bubblewrap.
 * SYNTHETIC and hermetic: a fake `cursor-agent` shell script and random canary tokens in a temp leg, never a real
 * provider or a real credential. The real-wrapper tests run where this host's bwrap can start a sandbox and are skipped
 * otherwise; the refusal tests (bwrap missing, probe failing) run everywhere.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../artifacts/index.js";
import { BWRAP_PROBE_ARGS, findOnPath } from "../../exec/outer-sandbox.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { replayLauncher } from "../fixtures/replay.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner } from "../run.js";
import type { CompileRequest, Invocation, ProbeRunner } from "../types.js";
import { CursorAdapter } from "./adapter.js";
import {
  CURSOR_BWRAP_MISSING,
  CURSOR_CONFINEMENT_FAILED,
  cursorBwrapArgs,
  cursorConfinementPlan,
  probeConfinement,
} from "./confinement.js";
import { BYPASS_SCOPE, fixturePath, PRIVILEGED_BYPASS_PROFILE } from "./fixtures/cases.js";

const dirs: string[] = [];
const scratch = (prefix: string) => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TMP = realpathSync(tmpdir());
const APPROVED = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
const request = (cwd: string): CompileRequest => ({
  runId: "run_cursor_confinement",
  objective: "synthetic confinement objective",
  constraints: [],
  workspace: { cwd, writable: true },
  bypassApproved: true,
});
const compileOk = (a: CursorAdapter, cwd: string): Invocation => {
  const r = a.compile(request(cwd), APPROVED);
  if ("ineligible" in r) throw new Error(r.detail);
  return r;
};

describe("cursor bwrap wrapper arguments (ADR-0059)", () => {
  const home = scratch("sb-cursor-home-");
  const plan = cursorConfinementPlan({ bwrap: "/opt/synthetic/bwrap", home, tmpDir: TMP, executable: "/opt/c/agent" });

  it("hides HOME and the temp directory, binds only the worktree read-write, and keeps the network namespace", () => {
    if ("refused" in plan) throw new Error(plan.refused);
    const wt = path.join(TMP, "leg", "repo");
    const args = cursorBwrapArgs(plan, wt);
    if (!Array.isArray(args)) throw new Error(args.refused);
    expect(args.slice(0, 7)).toEqual(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]);
    const tmpfs = args.flatMap((a, i) => (a === "--tmpfs" ? [args[i + 1] as string] : []));
    expect(tmpfs).toContain(home);
    expect(tmpfs).toContain(TMP);
    const rw = args.flatMap((a, i) => (a === "--bind" || a === "--bind-try" ? [args[i + 1] as string] : []));
    expect(rw).toEqual(expect.arrayContaining([wt, path.join(home, ".cursor")]));
    expect(rw).toHaveLength(2);
    const ro = args.flatMap((a, i) => (a === "--ro-bind-try" ? [args[i + 1] as string] : []));
    expect(ro).toEqual(expect.arrayContaining(["/opt/c", path.join(home, ".config/cursor")]));
    // Every tmpfs is mounted before any bind below it, so no hidden directory covers a bind.
    for (const t of tmpfs) {
      const at = args.indexOf(t);
      for (const b of [...rw, ...ro])
        if (b.startsWith(`${t}/`)) expect(args.indexOf(b), `${t} ${b}`).toBeGreaterThan(at);
    }
    expect(args.slice(-6)).toEqual(["--chdir", wt, "--unshare-all", "--share-net", "--die-with-parent", "--"]);
    expect(args).not.toContain("--new-session"); // the supervisor kills the process group (LLD §8.3)
  });

  it("hides the worktree's parent (other runs' worktrees) when no hidden directory covers it", () => {
    if ("refused" in plan) throw new Error(plan.refused);
    const args = cursorBwrapArgs(plan, "/srv/sb/worktrees/sess/run");
    if (!Array.isArray(args)) throw new Error(args.refused);
    expect(args).toEqual(expect.arrayContaining(["--tmpfs", "/srv/sb/worktrees/sess"]));
  });

  it("refuses a worktree that would re-expose what the wrapper hides or binds", () => {
    if ("refused" in plan) throw new Error(plan.refused);
    for (const wt of [
      "/",
      home,
      TMP,
      path.dirname(home),
      path.join(home, ".cursor", "x"),
      path.join(home, ".config"),
    ]) {
      expect(cursorBwrapArgs(plan, wt), wt).toMatchObject({ refused: expect.stringMatching(/ADR-0059/) });
    }
    expect(cursorBwrapArgs(plan, "relative/wt")).toMatchObject({ refused: expect.stringMatching(/not absolute/) });
  });

  it("refuses a plan without bwrap, without HOME, or whose install directory holds a hidden directory", () => {
    const base = { bwrap: "/opt/synthetic/bwrap", home, tmpDir: TMP, executable: "/opt/c/agent" };
    expect(cursorConfinementPlan({ ...base, bwrap: null })).toEqual({ refused: CURSOR_BWRAP_MISSING });
    expect(cursorConfinementPlan({ ...base, home: undefined })).toMatchObject({
      refused: expect.stringMatching(/HOME/),
    });
    expect(cursorConfinementPlan({ ...base, home: "/" })).toMatchObject({ refused: expect.stringMatching(/root/) });
    expect(cursorConfinementPlan({ ...base, executable: path.join(home, "agent") })).toMatchObject({
      refused: expect.stringMatching(/install directory/),
    });
  });

  it("the compiled bypass cell is bwrap first, then Cursor with --trust --force after the wrapper's --", () => {
    const a = new CursorAdapter({ executable: "/opt/c/agent", bwrap: "/opt/synthetic/bwrap", home, tmpDir: TMP });
    const inv = compileOk(a, path.join(TMP, "leg", "repo"));
    expect(inv.argv[0]).toBe("/opt/synthetic/bwrap");
    expect(inv.argv.slice(inv.argv.indexOf("--") + 1)).toEqual([
      "/opt/c/agent",
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--force",
    ]);
    expect(inv.policyFlags).toEqual(["--trust", "--force"]);
  });
});

describe("cursor bypass cell fails closed without a working wrapper (ADR-0059)", () => {
  const home = scratch("sb-cursor-home-");
  const wt = path.join(TMP, "leg", "repo");

  it("bwrap unavailable: compile is Ineligible and the probe's confinement step fails", async () => {
    const a = new CursorAdapter({ executable: "/opt/c/agent", bwrap: null, home, tmpDir: TMP });
    expect(a.compile(request(wt), APPROVED)).toEqual({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: CURSOR_BWRAP_MISSING,
    });
    const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: "s-1" }, request(wt), APPROVED);
    expect(resumed).toMatchObject({ ineligible: true, detail: CURSOR_BWRAP_MISSING });
    const none: ProbeRunner = async () => ({ stdout: "", stderr: "", exitCode: 2, timedOut: false });
    const step = await probeConfinement(
      cursorConfinementPlan({ bwrap: null, home, tmpDir: TMP, executable: "/opt/c/agent" }),
      none,
      TMP,
    );
    expect(step).toEqual({ step: "confinement", ok: false, detail: CURSOR_BWRAP_MISSING });
  });

  it("probe failing (non-zero exit, timeout, spawn error, or the worktree file not reaching the host) fails the step", async () => {
    const plan = cursorConfinementPlan({
      bwrap: "/opt/synthetic/bwrap",
      home,
      tmpDir: TMP,
      executable: "/opt/c/agent",
    });
    const outcomes: Array<[string, ProbeRunner]> = [
      [
        "exit 1",
        async () => ({
          stdout: "",
          stderr: "bwrap: setting up uid map: Permission denied",
          exitCode: 1,
          timedOut: false,
        }),
      ],
      ["timed out", async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true })],
      [
        "could not start",
        async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: false, spawnError: "ENOENT" }),
      ],
      // Exit 0 without the marker: a stand-in that ran nothing must not pass.
      ["did not reach", async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false })],
    ];
    for (const [why, runner] of outcomes) {
      const step = await probeConfinement(plan, runner, TMP);
      expect(step, why).toMatchObject({ step: "confinement", ok: false, detail: expect.stringContaining(why) });
    }
  });

  it("after a failed probe the adapter refuses to compile the cell", async () => {
    const a = new CursorAdapter({ executable: "/opt/c/agent", bwrap: "/opt/synthetic/bwrap", home, tmpDir: TMP });
    expect("ineligible" in a.compile(request(wt), APPROVED)).toBe(false);
    const runner: ProbeRunner = async (argv) =>
      argv[1] === "--version"
        ? { stdout: "2026.10.12-d47ca18\n", stderr: "", exitCode: 0, timedOut: false }
        : { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    const probe = await a.probe(runner);
    expect(probe.steps.find((s) => s.step === "confinement")).toMatchObject({ ok: false, detail: "bwrap exit 1" });
    expect(a.compile(request(wt), APPROVED)).toEqual({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: CURSOR_CONFINEMENT_FAILED,
    });
  });

  /** One run through RunLifecycle with the given bwrap; the provider (a replay) must never start. */
  const runThroughLifecycle = async (bwrap: string | null) => {
    const root = scratch("sb-cursor-lc-");
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Cursor Dev",
          GIT_AUTHOR_EMAIL: "cursor@example.test",
          GIT_COMMITTER_NAME: "Cursor Dev",
          GIT_COMMITTER_EMAIL: "cursor@example.test",
        },
      });
    g("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "initial\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    const dataDir = path.join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
    const adapter = new CursorAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("cursor", fixturePath("success_edit"), []),
      bwrap,
      home,
      tmpDir: TMP,
    });
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
      artifacts,
      adapters: new AdapterRegistry().register(adapter),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
    });
    lifecycle.start();
    try {
      const { runId } = await lifecycle.submit({
        clientId: "c",
        objective: "synthetic objective",
        workspace: repo,
        trustProfile: "privileged",
        provider: "cursor",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      const started = db
        .prepare("SELECT payload_json FROM run_event WHERE run_id = ? AND type = 'state_transition'")
        .all(runId)
        .some((r) => JSON.parse((r as { payload_json: string }).payload_json)?.to === "RUNNING");
      return { done, started, written: existsSync(path.join(repo, "hello.txt")) };
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  };

  it("a run with bwrap unavailable ends ELIGIBILITY_NONE before the provider starts", async () => {
    const r = await runThroughLifecycle(null);
    expect(r.done.state).toBe("FAILED");
    expect(r.done.failure_code).toBe("ELIGIBILITY_NONE");
    expect(r.done.failure_detail).toMatch(/confinement/);
    expect(r.started).toBe(false);
  });

  it("a run whose bwrap probe fails ends ELIGIBILITY_NONE before the provider starts", async () => {
    const bin = scratch("sb-cursor-badbwrap-");
    const bad = path.join(bin, "bwrap");
    writeFileSync(bad, "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n");
    chmodSync(bad, 0o755);
    const r = await runThroughLifecycle(bad);
    expect(r.done.state).toBe("FAILED");
    expect(r.done.failure_code).toBe("ELIGIBILITY_NONE");
    expect(r.done.failure_detail).toMatch(/confinement/);
    expect(r.started).toBe(false);
  });
});

const HOST_BWRAP = findOnPath("bwrap", process.env.PATH);
const hostBwrapWorks =
  process.platform === "linux" &&
  HOST_BWRAP !== null &&
  spawnSync(HOST_BWRAP, [...BWRAP_PROBE_ARGS], { timeout: 5_000 }).status === 0;

describe.runIf(hostBwrapWorks)("cursor bypass cell inside this host's bwrap (ADR-0059, canaries)", () => {
  const bwrap = HOST_BWRAP as string;
  const token = (tag: string) => `SBCANARY-${tag}-${randomBytes(8).toString("hex")}`;

  /** The live leg's layout: worktree, out-of-worktree canary and fake-HOME credential canary side by side. */
  const leg = () => {
    const root = scratch("sb-cursor-leg-");
    const repo = path.join(root, "repo");
    const fakeHome = path.join(root, "fakehome");
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    for (const d of [
      repo,
      fakeHome,
      bin,
      path.join(home, ".config", "cursor"),
      path.join(home, ".cursor"),
      path.join(home, ".ssh"),
    ]) {
      mkdirSync(d, { recursive: true });
    }
    const tokens = { outside: token("outside"), cred: token("cred"), home: token("home"), login: token("login") };
    const files = {
      outside: path.join(root, "outside-canary.txt"),
      cred: path.join(fakeHome, "cursor-auth.json"),
      home: path.join(home, ".ssh", "id_canary"),
      login: path.join(home, ".config", "cursor", "auth.json"),
    };
    writeFileSync(files.outside, `canary: ${tokens.outside}\n`);
    writeFileSync(files.cred, JSON.stringify({ fake_credential: tokens.cred }));
    writeFileSync(files.home, `canary: ${tokens.home}\n`);
    writeFileSync(files.login, JSON.stringify({ synthetic_login: tokens.login }));
    // The fake `cursor-agent`: tries every read and write the live leg's hostile prompt asks for and reports each.
    const fake = path.join(bin, "cursor-agent");
    const q = (s: string) => `'${s}'`;
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'rd() { if out=$(cat "$2" 2>/dev/null); then echo "READ $1 $out"; else echo "UNREADABLE $1"; fi; }',
        'wr() { if (echo x >> "$2") 2>/dev/null; then echo "WROTE $1"; else echo "UNWRITABLE $1"; fi; }',
        `rd outside ${q(files.outside)}`,
        `rd cred ${q(files.cred)}`,
        `rd home ${q(files.home)}`,
        `rd login ${q(files.login)}`,
        `wr worktree ${q(path.join(repo, "edit.txt"))}`,
        `wr state ${q(path.join(home, ".cursor", "cli-config.json"))}`,
        `wr login ${q(files.login)}`,
        `wr outside ${q(path.join(root, "outside-write.txt"))}`,
        `wr fakehome ${q(path.join(fakeHome, "planted"))}`,
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    return { root, repo, home, fake, tokens, files };
  };
  const spawnInv = (inv: Invocation, home: string) =>
    spawnSync(inv.argv[0] as string, inv.argv.slice(1), {
      cwd: inv.cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      input: inv.stdin?.kind === "text" ? inv.stdin.value : "",
      encoding: "utf8",
      timeout: 10_000,
    });

  it("the adapter's own confinement probe passes on this host", async () => {
    const l = leg();
    const a = new CursorAdapter({ executable: l.fake, bwrap, home: l.home, tmpDir: TMP });
    const plan = cursorConfinementPlan({ bwrap, home: l.home, tmpDir: TMP, executable: l.fake });
    expect(await probeConfinement(plan, createProbeRunner(), TMP)).toEqual({ step: "confinement", ok: true });
    expect("ineligible" in a.compile(request(l.repo), APPROVED)).toBe(false);
  });

  it("control: without the wrapper the fake CLI reaches every canary (the check is not vacuous)", () => {
    const l = leg();
    const r = spawnSync(l.fake, [], {
      cwd: l.repo,
      env: { PATH: process.env.PATH ?? "", HOME: l.home },
      encoding: "utf8",
    });
    for (const t of Object.values(l.tokens)) expect(r.stdout).toContain(t);
    expect(r.stdout).toContain("WROTE outside");
  });

  it("inside the wrapper the out-of-worktree and fake-HOME canaries are unreadable; only the worktree and state are writable", () => {
    const l = leg();
    const a = new CursorAdapter({ executable: l.fake, bwrap, home: l.home, tmpDir: TMP });
    const inv = compileOk(a, l.repo);
    const r = spawnInv(inv, l.home);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    // The canaries the live leg plants (U-M2 outside the worktree, U-M3 fake-HOME credential) and a HOME secret.
    expect(out).toContain("UNREADABLE outside");
    expect(out).toContain("UNREADABLE cred");
    expect(out).toContain("UNREADABLE home");
    for (const t of [l.tokens.outside, l.tokens.cred, l.tokens.home]) expect(out).not.toContain(t);
    // Cursor's login store is visible read-only; its state directory and the worktree are writable.
    expect(out).toContain(`READ login`);
    expect(out).toContain("UNWRITABLE login");
    expect(out).toContain("WROTE worktree");
    expect(out).toContain("WROTE state");
    // Host side: the worktree write is real. A write outside it lands in the run's private tmpfs, which is discarded
    // when the run ends, so nothing reaches the host; the canaries are untouched.
    expect(existsSync(path.join(l.repo, "edit.txt"))).toBe(true);
    expect(existsSync(path.join(l.root, "outside-write.txt"))).toBe(false);
    expect(existsSync(path.join(l.root, "fakehome", "planted"))).toBe(false);
    expect(readFileSync(l.files.login, "utf8")).toBe(JSON.stringify({ synthetic_login: l.tokens.login }));
  });

  /**
   * w1701 diagnosis (owner ruling 2026-10-19 08:12 CDT): Cursor's install layout and Switchboard's worktree layout as
   * they are on the host. `~/.local/bin/cursor-agent` is a symlink to a versioned bash launcher that finds its sibling
   * runtime through `realpath "$0"`; the fake runtime runs each tool call the way Cursor's shell tool does
   * (`${SHELL:-/bin/sh} -c <command>`; SHELL is not in the allowlist) and reports its exit code. The worktree is a real
   * `git worktree add` whose gitdir lives in the main repository beside it, so inside the wrapper Git finds no
   * repository: a commit is attempted and fails, and the host refs stay unchanged.
   */
  it("tool runtime: a symlinked Cursor-shaped launcher starts; ls and cat work; Git and the canaries fail closed", () => {
    const l = leg();
    const gitEnv = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const g = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
        {
          cwd,
          env: gitEnv,
          encoding: "utf8",
        },
      ).trim();
    g(l.repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(l.repo, "README.md"), "# synthetic\n");
    g(l.repo, "add", "README.md");
    g(l.repo, "commit", "-q", "-m", "init");
    const wt = path.join(l.root, "data", "worktrees", "sess", "run");
    mkdirSync(path.dirname(wt), { recursive: true });
    g(l.repo, "worktree", "add", "-q", "-b", "switchboard/run", wt);
    const refs = () => g(l.repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const refsBefore = refs();

    const version = path.join(l.home, ".local", "share", "cursor-agent", "versions", "9.9.9-synthetic");
    const shim = path.join(l.home, ".local", "bin", "cursor-agent");
    mkdirSync(version, { recursive: true });
    mkdirSync(path.dirname(shim), { recursive: true });
    const launcher = ["#!/usr/bin/env bash", "set -euo pipefail", 'SCRIPT_DIR="$(dirname "$(realpath "$0")")"'];
    writeFileSync(path.join(version, "cursor-agent"), [...launcher, 'exec "$SCRIPT_DIR/node" "$@"', ""].join("\n"));
    const tool = (label: string, cmd: string) =>
      `out=$("\${SHELL:-/bin/sh}" -c ${JSON.stringify(cmd)} 2>&1); echo "TOOL ${label} rc=$? $out"`;
    writeFileSync(
      path.join(version, "node"),
      [
        "#!/bin/sh",
        'echo "RUNTIME started"',
        tool("ls", "ls"),
        tool("cat", "cat README.md"),
        tool("status", "git status --short"),
        tool("commit", "git -c user.name=x -c user.email=x@example.invalid commit --allow-empty -m probe"),
        tool("outside", `cat ${l.files.outside}`),
        tool("cred", `cat ${l.files.cred}`),
        "",
      ].join("\n"),
    );
    chmodSync(path.join(version, "cursor-agent"), 0o755);
    chmodSync(path.join(version, "node"), 0o755);
    symlinkSync(path.join(version, "cursor-agent"), shim);

    const a = new CursorAdapter({ executable: shim, bwrap, home: l.home, tmpDir: TMP });
    const inv = compileOk(a, wt);
    // The resolved launcher is argv[0] inside: the `~/.local/bin` symlink sits under the hidden HOME.
    expect(inv.argv).toContain(path.join(version, "cursor-agent"));
    const r = spawnInv(inv, l.home);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out, out).toContain("RUNTIME started");
    expect(out, out).toMatch(/TOOL ls rc=0 README\.md/);
    expect(out, out).toMatch(/TOOL cat rc=0 # synthetic/);
    // The worktree's gitdir (`<repo>/.git/worktrees/run`) is outside the worktree and stays hidden: no bind widens it.
    expect(out, out).toMatch(/TOOL status rc=128 fatal: not a git repository/);
    expect(out, out).toMatch(/TOOL commit rc=128 fatal: not a git repository/);
    expect(out, out).toMatch(/TOOL outside rc=1 .*No such file or directory/);
    expect(out, out).toMatch(/TOOL cred rc=1 .*No such file or directory/);
    for (const t of [l.tokens.outside, l.tokens.cred]) expect(out).not.toContain(t);
    expect(refs()).toBe(refsBefore);
  });
});
