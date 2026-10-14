/**
 * Handoff bundle sources (T5.4; LLD §15.1 "Only source" column and §15.2; ADR-0038 items 1.2 and 1.3; FR-SES-04).
 *
 * This is the ONLY part of the builder that performs I/O, and it reads exactly three things:
 * - ledger rows through the narrow {@link BundleLedger} view: the meta-session's continuity columns, the run rows, the
 *   normalized `run_event` rows up to each run's `as_of` watermark, decisions, provider bindings and artifact metadata;
 * - the content of the two controller-produced artifact kinds `changed_files` and `test_report`, through
 *   {@link readControllerArtifact}, which checks the artifact row's kind, run and liveness before it reads a byte (the
 *   content of any other kind, including the provider stream artifacts and the `diff` evidence, is never read: a failed
 *   attempt names its diff by id and hash only);
 * - Git objects of the meta-session's repository through read-only plumbing (`git rev-parse --verify` and
 *   `git diff-tree` between the two recorded commits), with the hardened runner of `src/workspace/git.ts`
 *   (scrubbed environment, hooks off, filter and diff drivers neutralised). No working tree file is read.
 *
 * It opens no file itself (no `fs` import): the artifact store and Git are injected. It never reads
 * `meta_session.open_work_json` (LLD §15.3) and never a provider's home or state directory. Everything it returns is
 * plain data for the pure assembler in `bundle.ts`. A missing or inconsistent record throws {@link HandoffBundleError}.
 */
import type { ArtifactRow, DecisionRow, ProviderBindingRow, RunEventRow, RunRecord } from "../ledger/index.js";
import { git as hardenedGit } from "../workspace/git.js";
import { type AsOf, HandoffBundleError } from "./bundle-schema.js";

/** The ledger reads the builder needs; `createLedger` satisfies it. Read-only by construction (no writer is listed). */
export interface BundleLedger {
  getMetaSessionContinuity(id: string):
    | {
        id: string;
        objective: string;
        constraints_json: string;
        repo_root: string | null;
        base_commit: string | null;
        head_commit: string | null;
      }
    | undefined;
  listRunsForMetaSession(metaSessionId: string): RunRecord[];
  getRunRecord(id: string): RunRecord | undefined;
  maxRunEventSeq(runId: string): number;
  listRunEventsUpTo(runId: string, maxSeq: number): RunEventRow[];
  listDecisionsForRun(runId: string): DecisionRow[];
  listProviderBindings(metaSessionId: string): ProviderBindingRow[];
  getArtifact(id: string): ArtifactRow | undefined;
}

/** Content-addressed reads, verified against the address (`ArtifactStore.get` satisfies it). */
export interface BundleArtifactReader {
  get(sha256: string): Promise<Buffer>;
}

/** Read-only Git runner (default: the hardened runner of `src/workspace/git.ts`). */
export type BundleGit = (args: readonly string[], options: { cwd: string }) => Promise<{ stdout: Buffer }>;

export interface BundleReadDeps {
  readonly ledger: BundleLedger;
  readonly artifacts: BundleArtifactReader;
  readonly git?: BundleGit;
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;
type TerminalState = (typeof TERMINAL)[number];
const isTerminal = (s: string): s is TerminalState => (TERMINAL as readonly string[]).includes(s);
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SESSION_RE = /^sess_[0-9A-Za-z]{1,64}$/;

/** The controller-produced artifact kinds whose content the builder may read (LLD §15.1). Nothing else. */
export const READABLE_ARTIFACT_KINDS = ["changed_files", "test_report"] as const;
export type ReadableArtifactKind = (typeof READABLE_ARTIFACT_KINDS)[number];

/** One `changed_files` artifact entry (as `WorkspaceManager` writes it). */
export interface ArtifactChangedFile {
  readonly status: string;
  readonly path: string;
}

/** One command of a `test_report` artifact (version 1, `src/lifecycle/verification.ts`). Only these fields are kept. */
export interface TestReportCommand {
  readonly index: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SourceRun {
  readonly record: RunRecord;
  /** Events with `seq <= last_seq` of `as_of`, ascending. */
  readonly events: readonly RunEventRow[];
  /** The terminal `state_transition` payload (within the watermark). */
  readonly terminal: Readonly<Record<string, unknown>>;
  readonly decisions: readonly DecisionRow[];
  /** The binding of the native session the terminal payload names; `null` when it names none. */
  readonly binding: ProviderBindingRow | null;
  /** Metadata of the evidence `diff` artifact named by the post `checkpoint` event (content never read). */
  readonly evidenceDiff: { readonly artifact_id: string; readonly sha256: string } | null;
  /** Content of the run's `changed_files` artifact; read only for the failed attempts the bundle lists. */
  readonly changedFiles: readonly ArtifactChangedFile[] | null;
  /** Commands of the run's `test_report` artifact; read only for the diagnostics run. */
  readonly testReport: readonly TestReportCommand[] | null;
}

export interface BundleSources {
  readonly asOf: AsOf;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly runs: readonly SourceRun[];
  /** `git diff-tree -r -z --no-renames --name-status <base> <head>` output. */
  readonly nameStatus: Buffer;
  /** `git diff-tree -p ... <base> <head>` output (LLD §15.1 `diff_excerpts`). */
  readonly patch: Buffer;
}

const fail = (cause: string): never => {
  throw new HandoffBundleError(cause);
};

const parse = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(`${what} is not valid JSON`);
  }
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Take `as_of` for a meta-session (LLD §15.2): its base and head commits and every run with its highest event `seq`.
 * Every run must be terminal (FR-SES-06: a continuation is admitted only when none is active). Read in one transaction
 * when `immediate` is given, so the watermarks and commits are one consistent snapshot.
 */
export function takeAsOf(ledger: BundleLedger & { immediate?<T>(fn: () => T): T }, metaSessionId: string): AsOf {
  const read = (): AsOf => {
    const meta = ledger.getMetaSessionContinuity(metaSessionId) ?? fail("unknown meta-session");
    const runs = ledger.listRunsForMetaSession(metaSessionId);
    if (runs.length === 0) fail("the meta-session has no run");
    if (runs.some((r) => !isTerminal(r.state))) fail("a run of the meta-session is not terminal");
    if (meta.base_commit === null || meta.head_commit === null) fail("the meta-session has no base or head checkpoint");
    return {
      meta_session_id: meta.id,
      base_commit: meta.base_commit as string,
      head_commit: meta.head_commit as string,
      runs: runs.map((r) => ({ run_id: r.id, last_seq: ledger.maxRunEventSeq(r.id) })),
    };
  };
  return ledger.immediate ? ledger.immediate(read) : read();
}

/**
 * Read one controller-produced artifact of `kind` named by `artifactId` for `runId`. Refuses any other kind before a
 * byte is read, a row of another run, a row retention GC deleted and content that fails its integrity check.
 */
export async function readControllerArtifact(
  deps: Pick<BundleReadDeps, "ledger" | "artifacts">,
  artifactId: string,
  kind: ReadableArtifactKind,
  runId: string,
): Promise<unknown> {
  if (!(READABLE_ARTIFACT_KINDS as readonly string[]).includes(kind)) fail("artifact kind is not readable");
  const row = deps.ledger.getArtifact(artifactId) ?? fail(`artifact ${artifactId} is missing`);
  if (row.kind !== kind) fail(`artifact ${artifactId} is not a ${kind} artifact`);
  if (row.run_id !== runId) fail(`artifact ${artifactId} belongs to another run`);
  if (row.deleted_at !== null) fail(`artifact ${artifactId} was collected`);
  let bytes: Buffer;
  try {
    bytes = await deps.artifacts.get(row.sha256);
  } catch {
    return fail(`artifact ${artifactId} could not be read or failed its integrity check`);
  }
  return parse(bytes.toString("utf8"), `artifact ${artifactId}`);
}

function terminalPayload(events: readonly RunEventRow[], state: TerminalState, runId: string) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as RunEventRow;
    if (e.type !== "state_transition") continue;
    const p = parse(e.payload_json, `event ${e.id}`);
    if (isRecord(p) && typeof p.to === "string" && isTerminal(p.to)) {
      if (p.to !== state) fail(`run ${runId}: terminal event and run row disagree`);
      return p;
    }
  }
  return fail(`run ${runId}: no terminal event within the as_of watermark`);
}

/** First `post` checkpoint event of a run (the evidence of its edits). */
export function postCheckpointEvent(events: readonly RunEventRow[]): { event: RunEventRow; commit: string } | null {
  for (const e of events) {
    if (e.type !== "checkpoint") continue;
    const p = parse(e.payload_json, `event ${e.id}`);
    if (isRecord(p) && p.kind === "post" && typeof p.commit === "string") return { event: e, commit: p.commit };
  }
  return null;
}

const hasVerification = (events: readonly RunEventRow[]) => events.some((e) => e.type === "verification_command");

/** Artifact id the terminal payload names for `kind`, if any. */
function terminalArtifact(terminal: Record<string, unknown>, kind: string): string | null {
  const arts = isRecord(terminal.artifacts) ? terminal.artifacts : {};
  const id = arts[kind];
  return typeof id === "string" ? id : null;
}

function changedFilesOf(content: unknown, artifactId: string): ArtifactChangedFile[] {
  if (!Array.isArray(content)) return fail(`artifact ${artifactId} is not a changed-files list`);
  return content.map((e) => {
    if (!isRecord(e) || typeof e.status !== "string" || typeof e.path !== "string") {
      return fail(`artifact ${artifactId} has a malformed entry`);
    }
    return { status: e.status, path: e.path };
  });
}

function testReportOf(content: unknown, artifactId: string): TestReportCommand[] {
  if (!isRecord(content) || content.v !== 1 || !Array.isArray(content.commands)) {
    return fail(`artifact ${artifactId} is not a version 1 test report`);
  }
  return content.commands.map((c) => {
    if (!isRecord(c) || typeof c.index !== "number" || typeof c.stdout !== "string" || typeof c.stderr !== "string") {
      return fail(`artifact ${artifactId} has a malformed command`);
    }
    return { index: c.index, stdout: c.stdout, stderr: c.stderr };
  });
}

/** Number of newest failed attempts whose `changed_files` content the bundle may use (LLD §15.1). */
const FAILED_ATTEMPTS_READ = 10;

/**
 * Collect every source of the bundle at `asOf` (LLD §15.2). Validates `asOf` against the records first: the runs must be
 * runs of the meta-session, terminal, listed in `(created_at, id)` order, with a watermark that exists; the commits must
 * be full object names that resolve to commits in the meta-session's repository.
 */
export async function collectBundleSources(deps: BundleReadDeps, asOf: AsOf): Promise<BundleSources> {
  const { ledger } = deps;
  const runGit = deps.git ?? hardenedGit;
  if (typeof asOf?.meta_session_id !== "string" || !SESSION_RE.test(asOf.meta_session_id)) fail("as_of is malformed");
  if (!COMMIT_RE.test(asOf.base_commit) || !COMMIT_RE.test(asOf.head_commit)) fail("as_of commits are malformed");
  if (!Array.isArray(asOf.runs) || asOf.runs.length === 0) fail("as_of lists no run");

  const meta = ledger.getMetaSessionContinuity(asOf.meta_session_id) ?? fail("unknown meta-session");
  if (meta.repo_root === null) fail("the meta-session has no repository");
  const constraintsRaw = parse(meta.constraints_json, "meta-session constraints");
  if (!Array.isArray(constraintsRaw) || !constraintsRaw.every((c) => typeof c === "string")) {
    fail("meta-session constraints are not a list of strings");
  }

  const order = new Map(ledger.listRunsForMetaSession(asOf.meta_session_id).map((r, i) => [r.id, i]));
  let previous = -1;
  const seen = new Set<string>();
  const bindings = ledger.listProviderBindings(asOf.meta_session_id);
  const base: Omit<SourceRun, "changedFiles" | "testReport">[] = [];
  for (const entry of asOf.runs) {
    const runId = entry?.run_id;
    const lastSeq = entry?.last_seq;
    if (typeof runId !== "string" || !Number.isSafeInteger(lastSeq) || lastSeq < 1) fail("as_of run is malformed");
    if (seen.has(runId)) fail("as_of lists a run twice");
    seen.add(runId);
    const position = order.get(runId);
    if (position === undefined) fail(`run ${runId} is not a run of the meta-session`);
    if ((position as number) <= previous) fail("as_of runs are not in (created_at, id) order");
    previous = position as number;
    const record = ledger.getRunRecord(runId) ?? fail(`run ${runId} is missing`);
    if (!isTerminal(record.state)) fail(`run ${runId} is not terminal`);
    if (ledger.maxRunEventSeq(runId) < lastSeq) fail(`run ${runId}: the as_of watermark does not exist`);
    const events = ledger.listRunEventsUpTo(runId, lastSeq);
    const terminal = terminalPayload(events, record.state as TerminalState, runId);
    const nativeId = typeof terminal.native_session_id === "string" ? terminal.native_session_id : null;
    let binding: ProviderBindingRow | null = null;
    if (nativeId !== null) {
      binding =
        bindings.find((b) => b.provider === record.provider && b.native_session_id === nativeId) ??
        fail(`run ${runId}: its native session has no binding`);
    }
    const post = postCheckpointEvent(events);
    let evidenceDiff: SourceRun["evidenceDiff"] = null;
    if (post?.event.artifact_id) {
      const row = ledger.getArtifact(post.event.artifact_id) ?? fail(`run ${runId}: evidence diff row is missing`);
      if (row.kind !== "diff" || row.run_id !== runId) fail(`run ${runId}: evidence artifact is not its diff`);
      evidenceDiff = { artifact_id: row.id, sha256: row.sha256 };
    }
    base.push({
      record,
      events,
      terminal,
      decisions: ledger.listDecisionsForRun(runId),
      binding,
      evidenceDiff,
    });
  }

  // Controller artifacts: changed files of the newest failed attempts, the test report of the diagnostics run.
  const failedIdx = base.flatMap((r, i) => (r.record.state === "SUCCEEDED" ? [] : [i])).slice(-FAILED_ATTEMPTS_READ);
  const diagIdx = base.findLastIndex((r) => hasVerification(r.events));
  const runs: SourceRun[] = [];
  for (const [i, r] of base.entries()) {
    let changedFiles: ArtifactChangedFile[] | null = null;
    let testReport: TestReportCommand[] | null = null;
    const cfId = terminalArtifact(r.terminal as Record<string, unknown>, "changed_files");
    if (failedIdx.includes(i) && cfId !== null) {
      changedFiles = changedFilesOf(await readControllerArtifact(deps, cfId, "changed_files", r.record.id), cfId);
    }
    const trId = terminalArtifact(r.terminal as Record<string, unknown>, "test_report");
    if (i === diagIdx && trId !== null) {
      testReport = testReportOf(await readControllerArtifact(deps, trId, "test_report", r.record.id), trId);
    }
    runs.push({ ...r, changedFiles, testReport });
  }

  // Git: read-only plumbing against the repository's object store; no working tree is read.
  const cwd = meta.repo_root as string;
  const gitRun = async (args: readonly string[], what: string): Promise<Buffer> => {
    try {
      return (await runGit(args, { cwd })).stdout;
    } catch {
      return fail(`git ${what} failed`);
    }
  };
  for (const commit of [asOf.base_commit, asOf.head_commit]) {
    const out = await gitRun(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`],
      "rev-parse",
    );
    if (out.toString("utf8").trim() !== commit) fail("a recorded commit does not resolve");
  }
  const nameStatus = await gitRun(
    ["diff-tree", "-r", "-z", "--no-renames", "--name-status", asOf.base_commit, asOf.head_commit],
    "diff-tree --name-status",
  );
  const patch = await gitRun(
    [
      "diff-tree",
      "-r",
      "-p",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      asOf.base_commit,
      asOf.head_commit,
    ],
    "diff-tree -p",
  );

  return {
    // Normalised: only the four keys of LLD §15.2, so a caller's extra keys never reach the bundle or its hash.
    asOf: {
      meta_session_id: asOf.meta_session_id,
      base_commit: asOf.base_commit,
      head_commit: asOf.head_commit,
      runs: asOf.runs.map((r) => ({ run_id: r.run_id, last_seq: r.last_seq })),
    },
    goal: meta.objective,
    constraints: constraintsRaw as string[],
    runs,
    nameStatus,
    patch,
  };
}
