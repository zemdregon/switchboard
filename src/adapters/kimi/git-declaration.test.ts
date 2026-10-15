/**
 * T4.67 (FR-GIT-01, FR-GIT-02, FR-GIT-09; ADR-0049 item 5, TDD §4.7): the Kimi Code Git declaration. SYNTHETIC: the
 * executable path is a placeholder or the shared replay launcher, and the ACP auth probe is answered by a stand-in
 * runner; no `kimi` binary is run.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../artifacts/index.js";
import { GIT_FINALIZE_COMMIT_EVENT, GitPublisher, publishRefFor } from "../../git/index.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { createSwitchboardServer } from "../../mcp/server.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { auditAcpPlan, auditInvocation } from "../audit.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner } from "../run.js";
import type { CompileRequest, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { isIneligible } from "../types.js";
import { KIMI_GIT_CAPABILITIES, KIMI_GIT_WRITE_CONTROL, KimiAdapter } from "./adapter.js";
import { BYPASS_SCOPE, replayAdapter } from "./fixtures/cases.js";
import {
  ACP_SUBCOMMAND,
  AUTH_PROBE_INITIALIZE_ID,
  AUTH_PROBE_SESSION_ID,
  GIT_WRITE_CONTROL_DETAIL,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
} from "./protocol.js";

const EXE = "/opt/synthetic/kimi";
const OBJECTIVE = "fix the failing test";
const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: OBJECTIVE,
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const adapter = () => new KimiAdapter({ executable: EXE });
const profileOf = (name: TrustProfile): ResolvedProfile => resolveTrustProfile(name);
/** The restricted (ACP) cell: privileged without bypass, network `on`, repository configuration `enabled`. */
const ACP_SCOPE = { ...BYPASS_SCOPE, bypass: false } as const;

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-kimi-t467-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Answers the ACP auth probe (T4.64) with a usable session; the replay launcher answers `--version` and `--help`. */
const realRunner = createProbeRunner();
const syntheticAuthOk: ProbeRunner = async (argv, opts) =>
  argv.at(-1) === ACP_SUBCOMMAND
    ? {
        exitCode: 0,
        stdout: [
          { jsonrpc: "2.0", id: AUTH_PROBE_INITIALIZE_ID, result: { protocolVersion: 1 } },
          { jsonrpc: "2.0", id: AUTH_PROBE_SESSION_ID, result: { sessionId: "session_synthetic-probe" } },
        ]
          .map((m) => `${JSON.stringify(m)}\n`)
          .join(""),
        stderr: "",
        timedOut: false,
      }
    : realRunner(argv, opts);

describe("kimi Git declaration (T4.67, FR-GIT-01, FR-GIT-02, FR-GIT-09)", () => {
  it("declares that Kimi Code documents no per-run Git write control, leaving FR-GIT-03 and FR-GIT-06", () => {
    const c = adapter().gitWriteControl;
    expect(c).toBe(KIMI_GIT_WRITE_CONTROL);
    expect(c.kind).toBe("none-documented");
    expect(c.remainingControls).toEqual(["FR-GIT-03", "FR-GIT-06"]);
    expect(c.detail).toBe(GIT_WRITE_CONTROL_DETAIL);
    expect(c.detail).toMatch(/Kimi Code CLI 2\.1\.1/);
    expect(c.detail).toMatch(/ADR-0039/);
    expect(c.detail).toMatch(/Unverified: T4\.68/);
  });

  it("declares a finalize-only commit channel with no injected tool (FR-GIT-09, owner decision 36)", () => {
    const caps = adapter().gitCapabilities;
    expect(caps).toBe(KIMI_GIT_CAPABILITIES);
    expect(caps.commitChannel).toBe("finalize-only");
    expect(caps.detail).toMatch(/FR-GIT-09/);
    expect(caps.detail).toMatch(/no tool is injected/);
  });

  it("list_capabilities reports Kimi Code's Git-write declaration through MCP", async () => {
    const root = realpathSync(makeCwd());
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const registry = new AdapterRegistry().register(adapter());
    const real = createProbeRunner();
    const probeRunner: ProbeRunner = async (argv, opts) =>
      argv[0] === process.execPath
        ? real(argv, opts)
        : { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "refused in tests" };
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
      artifacts,
      adapters: registry,
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      probeRunner,
      eligibility: { platform: "linux", gate: (id, v, dir) => registry.gate(id, v, dir) },
    });
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config: {
        allowedRoots: [root],
        projects: [],
        mcpClients: new Map([["c1", { id: "c1", maxTrustProfile: "edit-untrusted" as const }]]),
      },
      clientId: "c1",
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.server.connect(serverSide);
      await client.connect(clientSide);
      const res = await client.callTool({ name: "list_capabilities", arguments: {} });
      const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}");
      const kimi = body.providers.find((p: { provider: string }) => p.provider === "kimi");
      expect(kimi).toBeDefined();
      expect(kimi.git_write_control).toEqual({
        kind: "none-documented",
        detail: GIT_WRITE_CONTROL_DETAIL,
        remaining_controls: ["FR-GIT-03", "FR-GIT-06"],
      });
    } finally {
      await client.close();
      await mcp.close();
      await lifecycle.shutdown();
      db.close();
    }
  });

  it("no compiled invocation (bypass or ACP, first run or resume) carries a git command or Git env", () => {
    const bypass = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const acp = privilegedProfile(ACP_SCOPE);
    const binding = { provider: "kimi" as const, nativeSessionId: "session_00000000-0000-4000-8000-000000000042" };
    const cells = [
      ["bypass initial", adapter().compile(request({ bypassApproved: true }), bypass), bypass, true],
      ["bypass resumed", adapter().resumeArgs(binding, request({ bypassApproved: true }), bypass), bypass, true],
      ["acp initial", adapter().compile(request(), acp), acp, false],
      ["acp resumed", adapter().resumeArgs(binding, request(), acp), acp, false],
    ] as const;
    for (const [name, r, profile, bypassApproved] of cells) {
      if (isIneligible(r)) throw new Error(`${name}: unexpected ineligible: ${r.detail}`);
      expect(auditInvocation(r, { profile, bypassApproved }), name).toEqual([]);
      if (r.transport === "subprocess-jsonl") {
        // The prompt is the one `--prompt=` word; nothing else carries it.
        expect(
          r.argv.filter((a) => a.includes(OBJECTIVE)),
          name,
        ).toEqual([`--prompt=${OBJECTIVE}`]);
      } else {
        expect(r.argv, name).toEqual([EXE, ACP_SUBCOMMAND]);
        expect(r.acp?.prompt, name).toBe(OBJECTIVE);
        // No injected commit channel until tool exposure is observed (ADR-0049 item 5, TDD §4.7).
        expect(r.acp?.mcpServers, name).toEqual([]);
        expect(auditAcpPlan(r, "kimi"), name).toEqual([]);
      }
      for (const a of [...r.argv.slice(1), ...r.policyFlags]) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} argv/policyFlags has git: ${a}`).toBe(false);
      }
      expect(r.envAllowlist, name).toEqual(["PATH", "HOME"]);
      expect(r.env, name).toEqual({});
    }
  });

  it.each([
    "git commit",
    "git commit -m x",
    "git push",
    "git push origin main",
    "git branch -f main",
    "git update-ref refs/heads/x HEAD",
    "git tag v1",
    "gh pr create",
    "git reset --hard",
    "git merge x",
    "git rebase main",
    "git cherry-pick abc",
    "git stash",
    "git -C . commit",
    "git --git-dir=/repo/.git commit",
    "/usr/bin/git push",
    "env git commit",
    "xargs git push",
  ])("shell allowlist entry %j is Ineligible PROFILE_UNSUPPORTED citing FR-GIT-01, on every cell", (entry) => {
    const cells: [string, KimiAdapter, CompileRequest, ResolvedProfile][] = [
      ["edit-untrusted", adapter(), request(), profileOf("edit-untrusted")],
      [
        "approved bypass",
        adapter(),
        request({ bypassApproved: true }),
        { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true },
      ],
      ["acp", adapter(), request(), privilegedProfile(ACP_SCOPE)],
      // Checked before every other reason: an unapproved bypass, network off and a missing binary.
      ["unapproved bypass", adapter(), request(), privilegedProfile(BYPASS_SCOPE)],
      ["network off", adapter(), request(), privilegedProfile({ ...ACP_SCOPE, network: { mode: "off" } })],
      ["no binary", new KimiAdapter({ pathEnv: "" }), request(), privilegedProfile(ACP_SCOPE)],
    ];
    for (const [name, a, req, profile] of cells) {
      const r = a.compile(req, { ...profile, shellAllowlist: [entry] });
      expect(r, name).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
      if (isIneligible(r)) {
        expect(r.detail, name).toContain("FR-GIT-01");
        expect(r.detail, name).toContain(entry);
      }
      const resumed = a.resumeArgs({ provider: "kimi", nativeSessionId: "session_1" }, req, {
        ...profile,
        shellAllowlist: [entry],
      });
      expect(resumed, `${name} resume`).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    }
  });

  it("read-only Git commands in a shell allowlist do not trigger the FR-GIT-01 refusal", () => {
    const readOnly = ["git status", "git diff", "git log", "npm test"];
    const r = adapter().compile(request(), { ...profileOf("edit-untrusted"), shellAllowlist: readOnly });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r)) {
      expect(r.detail).not.toContain("FR-GIT-01");
      expect(r.detail).toContain(NON_PRIVILEGED_UNSUPPORTED_DETAIL);
    }
    const acp = adapter().compile(request(), { ...privilegedProfile(ACP_SCOPE), shellAllowlist: readOnly });
    expect(isIneligible(acp)).toBe(false);
  });

  it("a replayed write run in a finalize-only project gets the controller commit at FINALIZING", async () => {
    const root = realpathSync(makeCwd());
    const repo = join(root, "repo");
    const bare = join(root, "remote.git");
    mkdirSync(repo);
    const g = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Kimi Dev",
          GIT_AUTHOR_EMAIL: "kimi@example.test",
          GIT_COMMITTER_NAME: "Kimi Dev",
          GIT_COMMITTER_EMAIL: "kimi@example.test",
        },
        encoding: "utf8",
      }).trim();

    g(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "initial\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "init");
    g(root, "init", "-q", "--bare", "-b", "main", bare);
    g(repo, "remote", "add", "origin", bare);
    g(repo, "push", "-q", "origin", "main");

    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
      artifacts,
      adapters: new AdapterRegistry().register(replayAdapter("success_edit")),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      finalizePublisher: new GitPublisher({
        db,
        scratchDir: join(dataDir, "git-scratch"),
        allowedStates: ["FINALIZING"],
      }),
      probeRunner: syntheticAuthOk,
    });
    lifecycle.start();

    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "write a file with kimi",
        workspace: repo,
        trustProfile: "privileged",
        provider: "kimi",
        project: {
          id: "test-project",
          name: "Test Project",
          environment_kind: "host",
          context_id: "primary",
          base_ref: "main",
          effective_max_profile: "privileged",
          writable: true,
          identity: { name: "Kimi Dev", email: "kimi@example.test" },
          push: { policy: "branch" },
          finalize_commit: true,
        },
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });

      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

      const events = ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) }));
      expect(events.find((e) => e.type === "state_transition" && e.p.to === "FINALIZING")).toBeDefined();
      const commits = events.filter((e) => e.type === GIT_FINALIZE_COMMIT_EVENT);
      expect(commits).toHaveLength(1);
      expect(commits[0]?.p).toMatchObject({ outcome: "committed" });

      const sha = g(repo, "rev-parse", "--verify", "--quiet", publishRefFor(metaSessionId));
      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(g(repo, "show", "--name-only", "--format=", sha)).toContain("hello.txt");
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });
});
