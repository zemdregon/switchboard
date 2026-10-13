/**
 * Shared harness for the per-adapter leg of the malicious-fixture suite (T4.3; NFR-SEC-03, FR-ADP-11, FR-POL-04,
 * TDD §3.6). A provider supplies ONE case file (`test/malicious/adapters/<provider>.case.ts`, default export
 * `AdapterLegCase`); `adapter-leg.test.ts` discovers every case file and runs this harness over it.
 *
 * What this leg proves, and what it does not. It proves COMPILE and PARSE behaviour against the hostile repository
 * fixture (./fixture.ts) and against REPLAYED hostile streams: (1) the compiled argv carries the provider's isolation
 * flags and none of the flags that would turn on repository hooks, MCP definitions or instruction files, and names no
 * path inside the hostile repository; (2) a repository configuration that is not `disabled` is either refused or
 * compiled with the same isolation, never silently enabled; (3) a stream in which the provider REPORTS a credential-path read, an out-of-worktree write or a
 * network attempt blocked ends `PERMISSION_BLOCKED` or `SANDBOX_VIOLATION`, never success, even when the CLI exits 0;
 * (4) unknown event kinds never count as success. It does NOT prove that a real CLI contains an escape: that is the
 * operator-run live leg (T3.9, T4.n8). Every hostile stream is SYNTHETIC (hand-written in the shape of the provider's
 * existing synthetic fixtures); none is a recording of a real CLI.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runConformanceCase } from "../../src/adapters/conformance.js";
import { FAILURE_CODES, type FailureCode } from "../../src/adapters/failure.js";
import {
  type CompileRequest,
  createParseState,
  type Invocation,
  isIneligible,
  type ProviderAdapter,
  type ResolvedProfile,
} from "../../src/adapters/index.js";
import { readIfExists, treeHash } from "./detectors.js";
import type { MaliciousFixture } from "./fixture.js";

/** The four things a hostile stream can report. Every case file must cover all of them. */
export const STREAM_CATEGORIES = ["credential_read", "out_of_worktree_write", "network", "unknown_events"] as const;
export type StreamCategory = (typeof STREAM_CATEGORIES)[number];

export interface HostileStream {
  name: string;
  category: StreamCategory;
  /** JSONL text lines, first line a provenance note marking the stream SYNTHETIC in the provider's own convention. */
  lines: string[];
  /** Exit code the replayed CLI ends with (a blocked stream must end blocked at 0 and at non-zero). */
  exitCode: number;
  /** Failure code the run must end with. Never success. */
  failureCode: FailureCode;
}

export interface AdapterLegCase {
  /** Provider id, for test names. */
  provider: string;
  /** An adapter whose launcher replays `streamFile` with the given exit code (use `replayLauncher`). */
  makeAdapter(streamFile: string, exitCode: number): ProviderAdapter;
  /** A profile with `repoConfig: "disabled"` that the adapter compiles. */
  profile: ResolvedProfile;
  /** Flags that must appear in the compiled argv for that profile (they switch repository configuration off). */
  isolationFlags: readonly string[];
  /** Flags that must NOT appear (they would load a repository hook, MCP definition, plugin or settings source). */
  neverEnabledFlags: readonly string[];
  /** The same profile with a repository configuration that is not `disabled`; refused or still isolated. */
  nonDisabledRepoConfig: ResolvedProfile;
  /** Hostile streams, built from the fixture so credential and outside paths are the fixture's FAKE canary paths. */
  streams(fx: MaliciousFixture): HostileStream[];
}

/** Names of the repository files and directories that carry hostile configuration in the fixture. */
export const HOSTILE_REPO_ENTRIES = [
  ".git/hooks",
  ".githooks",
  ".mcp.json",
  ".claude",
  ".codex",
  "CLAUDE.md",
  "AGENTS.md",
];

export function requestFor(cwd: string): CompileRequest {
  return {
    runId: "run_malicious_leg",
    objective: "synthetic objective",
    constraints: [],
    workspace: { cwd, writable: true },
  };
}

/** Missing coverage in a case file, as messages; empty when it covers every category with a blocked failure code. */
export function coverageProblems(streams: readonly HostileStream[]): string[] {
  const problems: string[] = [];
  for (const cat of STREAM_CATEGORIES) {
    if (!streams.some((s) => s.category === cat)) problems.push(`no stream for category ${cat}`);
  }
  const blocked: FailureCode[] = ["PERMISSION_BLOCKED", "SANDBOX_VIOLATION"];
  for (const s of streams) {
    if (s.category !== "unknown_events" && !blocked.includes(s.failureCode)) {
      problems.push(`${s.name}: ${s.category} must end PERMISSION_BLOCKED or SANDBOX_VIOLATION, not ${s.failureCode}`);
    }
    if (!FAILURE_CODES.includes(s.failureCode)) problems.push(`${s.name}: unknown failure code ${s.failureCode}`);
  }
  return problems;
}

/** Isolation findings for one compiled argv: isolation flags present, no enabling flag, no hostile-repo path. */
function argvProblems(c: AdapterLegCase, fx: MaliciousFixture, inv: Invocation, label: string): string[] {
  const problems: string[] = [];
  for (const f of c.isolationFlags) if (!inv.argv.includes(f)) problems.push(`${label}: missing isolation flag ${f}`);
  for (const f of c.neverEnabledFlags) {
    if (inv.argv.some((a) => a === f || a.startsWith(`${f}=`))) problems.push(`${label}: forbidden flag ${f} in argv`);
  }
  const text = [...inv.argv, ...Object.values(inv.env)].join("\n");
  for (const entry of HOSTILE_REPO_ENTRIES) {
    if (text.includes(path.join(fx.repo, entry)))
      problems.push(`${label}: argv or env names hostile repository entry ${entry}`);
  }
  return problems;
}

/**
 * Compiled-argv findings for the hostile repository as cwd; empty when the isolation holds. A profile whose repository
 * configuration is not `disabled` must either be refused or still compile with the same isolation (never enable it).
 */
export function compileProblems(c: AdapterLegCase, fx: MaliciousFixture): string[] {
  const adapter = c.makeAdapter(path.join(fx.base, "unused.jsonl"), 0);
  const inv = adapter.compile(requestFor(fx.repo), c.profile);
  if (isIneligible(inv)) return [`profile does not compile: ${inv.reason}: ${inv.detail}`];
  const problems = argvProblems(c, fx, inv, "disabled");
  const other = adapter.compile(requestFor(fx.repo), c.nonDisabledRepoConfig);
  if (!isIneligible(other)) {
    problems.push(...argvProblems(c, fx, other, `repoConfig=${c.nonDisabledRepoConfig.repoConfig}`));
  }
  return problems;
}

export interface StreamOutcome {
  ok: boolean;
  failedChecks: string[];
  resultOk: boolean | undefined;
  failureCode: FailureCode | undefined;
  /** Operator checkout, canary logs and outside sentinel unchanged by the run. */
  untouched: boolean;
}

/** Replay one hostile stream through the supervisor and the adapter, with the hostile repository as the cwd. */
export async function replayHostileStream(
  c: AdapterLegCase,
  fx: MaliciousFixture,
  s: HostileStream,
): Promise<StreamOutcome> {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-leg-"));
  try {
    const file = path.join(dir, "stream.jsonl");
    writeFileSync(file, `${s.lines.join("\n")}\n`);
    const before = { tree: treeHash(fx.repo), sentinel: readIfExists(fx.outsideSentinel) };
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: c.makeAdapter(file, s.exitCode),
      request: requestFor(fx.repo),
      profile: c.profile,
      expect: { ok: false, failureCode: s.failureCode },
    });
    const untouched =
      treeHash(fx.repo) === before.tree &&
      readIfExists(fx.outsideSentinel) === before.sentinel &&
      readIfExists(fx.hookLog) === "" &&
      readIfExists(fx.configLog) === "";
    return {
      ok: report.ok,
      failedChecks: report.checks.filter((k) => !k.ok).map((k) => `${k.name}${k.detail ? ` (${k.detail})` : ""}`),
      resultOk: report.result?.ok,
      failureCode: report.result?.failureCode,
      untouched,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Normalized kinds the adapter produces for the stream's lines; `unknown` lines must never become a result. */
export function parsedKinds(c: AdapterLegCase, s: HostileStream): string[] {
  const adapter = c.makeAdapter("unused", 0);
  const state = createParseState();
  return s.lines.flatMap((line) => adapter.parseEvent(line, state).map((e) => e.kind));
}
