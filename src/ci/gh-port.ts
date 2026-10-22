/**
 * Production {@link CiStatusPort} (T15.3; ADR-0050): runs the operator's logged-in `gh` as an external subprocess with
 * an argv from the closed allowlist (`gh-argv.ts`), no shell, an allowlisted environment and a wall-clock bound. Only
 * allowlisted JSON fields are read; this port discards stderr and no `gh` output reaches an error message, log or the
 * ledger. {@link execGh} keeps a bounded stderr tail only for the pull-request port's failure detail (ADR-0095).
 * Tests inject {@link GhRunner}; CI never runs a real `gh`.
 */
import { execFile } from "node:child_process";
import {
  branchOfPublishRef,
  ghCheckRunsArgv,
  ghEnv,
  ghPrGateViewArgv,
  ghPrMergeArgv,
  ghPrMergeStateArgv,
  ghPrReportedChecksArgv,
  ghPrRequiredChecksArgv,
  ghPrUpdateBranchArgv,
  ghPrViewArgv,
  ghRunCancelArgv,
  ghRunHeadArgv,
  ghRunJobsArgv,
  ghRunListArgv,
  ghRunListQueuedArgv,
  ghRunRerunFailedArgv,
  ghRunViewArgv,
  isFullLowerSha,
  parseCheckRuns,
  parsePrGateView,
  parsePrMergeState,
  parsePrView,
  parseQueuedRuns,
  parseReportedChecks,
  parseRequiredChecks,
  parseRunHead,
  parseRunJobs,
  parseRunList,
  parseRunView,
} from "./gh-argv.js";
import {
  type CiActionsPort,
  type CiBranchUpdatePort,
  type CiConclusion,
  type CiMergePort,
  type CiPullRequestGateView,
  type CiPullRequestMergeState,
  type CiPullRequestMergeStatePort,
  type CiPullRequestPort,
  type CiPullRequestState,
  type CiQueuedRun,
  type CiReportedChecks,
  type CiRequiredChecks,
  type CiRunJob,
  type CiRunQuery,
  CiStatusError,
  type CiStatusObservation,
  type CiStatusPort,
  type CiStatusQuery,
} from "./port.js";

/** `gh` exit code for "authentication required" (`gh help exit-codes`). */
export const GH_EXIT_AUTH_REQUIRED = 4;
/** `gh pr checks` exit code for "checks pending" (`gh pr checks` manual). */
export const GH_EXIT_CHECKS_PENDING = 8;
export const DEFAULT_GH_TIMEOUT_MS = 30_000;
const MAX_GH_STDOUT_BYTES = 1024 * 1024;
/** ADR-0095: most characters of a failed run's stderr kept on {@link GhRunResult.stderr} (its tail). */
export const MAX_GH_STDERR_CHARS = 4096;

export interface GhRunResult {
  /** Exit code, or null when the process was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut?: boolean;
  /** The binary was not found. */
  readonly notFound?: boolean;
  /**
   * ADR-0095: the tail (at most {@link MAX_GH_STDERR_CHARS}) of stderr when `gh` exited non-zero; raw and unsanitised,
   * so only the pull-request port reads it, through `ghFailureDetail`.
   */
  readonly stderr?: string;
}

export type GhRunner = (
  binary: string,
  argv: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number },
) => Promise<GhRunResult>;

/** Default runner: `execFile` (never a shell), stdout capped, stderr kept (tail) only for a non-zero exit. */
export const execGh: GhRunner = (binary, argv, { env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      binary,
      [...argv],
      {
        env,
        shell: false,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_GH_STDOUT_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err === null) return resolve({ exitCode: 0, stdout: String(stdout) });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null };
        if (e.code === "ENOENT") return resolve({ exitCode: null, stdout: "", notFound: true });
        if (e.killed === true || e.signal === "SIGKILL") return resolve({ exitCode: null, stdout: "", timedOut: true });
        resolve({
          exitCode: typeof e.code === "number" ? e.code : 1,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "").slice(-MAX_GH_STDERR_CHARS),
        });
      },
    );
  });

const KNOWN: ReadonlySet<string> = new Set<CiConclusion>([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "skipped",
  "neutral",
]);

export interface GhCiStatusPortOptions {
  /** `ci_trigger.gh_binary` (default `gh`, resolved on PATH). */
  readonly binary?: string;
  readonly runner?: GhRunner;
  /** Environment the allowlisted variables are copied from (default `process.env`). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** G3 check-run fallback when the branch has no workflow run (default off). */
  readonly useCheckRunsFallback?: boolean;
}

export class GhCiStatusPort
  implements
    CiStatusPort,
    CiActionsPort,
    CiPullRequestPort,
    CiMergePort,
    CiBranchUpdatePort,
    CiPullRequestMergeStatePort
{
  private readonly binary: string;
  private readonly runner: GhRunner;
  private readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly checkRunsFallback: boolean;

  constructor(options: GhCiStatusPortOptions = {}) {
    this.binary = options.binary ?? "gh";
    this.runner = options.runner ?? execGh;
    this.sourceEnv = options.sourceEnv ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
    this.checkRunsFallback = options.useCheckRunsFallback === true;
  }

  async latestForPublishedRef(q: CiStatusQuery): Promise<CiStatusObservation | null> {
    const branch = branchOfPublishRef(q.publishRef);
    const sha = q.headSha.toLowerCase();
    if (branch === undefined || !isFullLowerSha(sha)) throw new CiStatusError("PARSE_FAILED", "invalid published ref");
    const run = this.parse(await this.run(ghRunListArgv(q.owner, q.repo, branch)), parseRunList);
    if (run === null) return this.checkRunsFallback ? this.checkRuns(q, sha) : null;
    if (run.headBranch !== branch) throw new CiStatusError("PARSE_FAILED", "run is for another branch");
    if (run.headSha?.toLowerCase() !== sha || run.status !== "completed") return null;
    const view = this.parse(await this.run(ghRunViewArgv(q.owner, q.repo, run.databaseId)), parseRunView);
    if (view.databaseId !== run.databaseId) throw new CiStatusError("PARSE_FAILED", "run id changed");
    if (view.status !== "completed" || !KNOWN.has(view.conclusion)) return null;
    return {
      externalId: run.databaseId,
      conclusion: view.conclusion as CiConclusion,
      publishRef: q.publishRef,
      headSha: sha,
    };
  }

  private async checkRuns(q: CiStatusQuery, sha: string): Promise<CiStatusObservation | null> {
    const latest = this.parse(await this.run(ghCheckRunsArgv(q.owner, q.repo, sha)), parseCheckRuns);
    if (latest === null || !KNOWN.has(latest.conclusion)) return null;
    return {
      externalId: latest.databaseId,
      conclusion: latest.conclusion as CiConclusion,
      publishRef: q.publishRef,
      headSha: sha,
    };
  }

  async runJobs(q: CiRunQuery): Promise<{ attempt: number; jobs: readonly CiRunJob[] }> {
    return this.parse(await this.run(ghRunJobsArgv(q.owner, q.repo, q.runId)), parseRunJobs);
  }

  async rerunFailed(q: CiRunQuery): Promise<void> {
    await this.run(ghRunRerunFailedArgv(q.owner, q.repo, q.runId));
  }

  async queuedRuns(q: { owner: string; repo: string; publishRef: string }): Promise<readonly CiQueuedRun[]> {
    const branch = branchOfPublishRef(q.publishRef);
    if (branch === undefined) throw new CiStatusError("PARSE_FAILED", "invalid published ref");
    const runs = this.parse(await this.run(ghRunListQueuedArgv(q.owner, q.repo, branch)), parseQueuedRuns);
    return runs.map((r) => ({
      runId: r.databaseId,
      status: r.status,
      headSha: (r.headSha ?? "").toLowerCase(),
      headBranch: r.headBranch ?? "",
    }));
  }

  async runHead(q: CiRunQuery): Promise<{ status: string; headSha: string }> {
    const head = this.parse(await this.run(ghRunHeadArgv(q.owner, q.repo, q.runId)), parseRunHead);
    if (head.databaseId !== q.runId) throw new CiStatusError("PARSE_FAILED", "run id changed");
    return { status: head.status, headSha: head.headSha.toLowerCase() };
  }

  async cancelRun(q: CiRunQuery): Promise<void> {
    await this.run(ghRunCancelArgv(q.owner, q.repo, q.runId));
  }

  /**
   * G9 (T15.7). `gh pr view` exits 1 when the branch has no pull request; stderr is never read, so exit 1 resolves null
   * (Delegated: nothing is admitted either way, fail closed). Any other failure throws as for the other templates.
   */
  async pullRequestForPublishedRef(q: {
    owner: string;
    repo: string;
    publishRef: string;
  }): Promise<CiPullRequestState | null> {
    const branch = branchOfPublishRef(q.publishRef);
    if (branch === undefined) throw new CiStatusError("PARSE_FAILED", "invalid published ref");
    const argv = ghPrViewArgv(q.owner, q.repo, branch);
    const r = await this.runner(this.binary, argv, { env: ghEnv(this.sourceEnv), timeoutMs: this.timeoutMs });
    if (r.exitCode === 1 && r.notFound !== true && r.timedOut !== true) return null;
    const pr = this.parse(this.check(r), parsePrView);
    return {
      number: pr.number,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      headSha: pr.headRefOid,
    };
  }

  /** G10 (T15.8). Exit 1 resolves null as for G9 (no pull request on the branch; stderr is never read). */
  async pullRequestGateView(q: {
    owner: string;
    repo: string;
    publishRef: string;
  }): Promise<CiPullRequestGateView | null> {
    const branch = branchOfPublishRef(q.publishRef);
    if (branch === undefined) throw new CiStatusError("PARSE_FAILED", "invalid published ref");
    const argv = ghPrGateViewArgv(q.owner, q.repo, branch);
    const r = await this.runner(this.binary, argv, { env: ghEnv(this.sourceEnv), timeoutMs: this.timeoutMs });
    if (r.exitCode === 1 && r.notFound !== true && r.timedOut !== true) return null;
    const pr = this.parse(this.check(r), parsePrGateView);
    return {
      number: pr.number,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      headSha: pr.headRefOid,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
    };
  }

  /**
   * G11 (T15.8). `gh pr checks` exits 1 when a check failed and 8 when one is pending (manual), and exits 1 with no
   * stdout when the base reports no required check. Assumption (the installed `gh` could not be asked on the build
   * host): with `--json` the array is printed in each of those cases, so exit 0, 1 or 8 with a JSON array is read as
   * the array, exit 1 with empty stdout as `none`, anything else as an error. Every reading fails closed: `none` and an
   * error both refuse the merge.
   */
  async requiredChecks(q: { owner: string; repo: string; prNumber: number }): Promise<CiRequiredChecks> {
    return this.readChecks(ghPrRequiredChecksArgv(q.owner, q.repo, String(q.prNumber)), parseRequiredChecks);
  }

  /** G18 (ADR-0087 item 7): as {@link requiredChecks} without `--required`; none reported reads as `none`. */
  async reportedChecks(q: { owner: string; repo: string; prNumber: number }): Promise<CiReportedChecks> {
    return this.readChecks(ghPrReportedChecksArgv(q.owner, q.repo, String(q.prNumber)), parseReportedChecks);
  }

  /** G19 (ADR-0087 item 7): the state and merge commit of one pull request of any `owner/repo`; no `gh` text is kept. */
  async pullRequestMergeState(q: { owner: string; repo: string; prNumber: number }): Promise<CiPullRequestMergeState> {
    const out = this.parse(await this.run(ghPrMergeStateArgv(q.owner, q.repo, String(q.prNumber))), parsePrMergeState);
    return out.mergeCommitSha === undefined
      ? { state: out.state }
      : { state: out.state, mergeCommitSha: out.mergeCommitSha };
  }

  private async readChecks(argv: string[], parseFn: (s: string) => string[]): Promise<CiRequiredChecks> {
    const r = await this.runner(this.binary, argv, { env: ghEnv(this.sourceEnv), timeoutMs: this.timeoutMs });
    const soft =
      r.notFound !== true && r.timedOut !== true && (r.exitCode === 1 || r.exitCode === GH_EXIT_CHECKS_PENDING);
    if (soft && r.exitCode === 1 && r.stdout.trim() === "") return { kind: "none" };
    const buckets = this.parse(soft ? r.stdout : this.check(r), parseFn);
    return buckets.length === 0 ? { kind: "none" } : { kind: "checks", buckets };
  }

  /** G12 (T15.8 write verb). Any non-zero exit, a moved head included, throws. */
  async mergePullRequest(q: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
    headSha: string;
  }): Promise<void> {
    await this.run(ghPrMergeArgv(q.owner, q.repo, String(q.prNumber), q.method, q.headSha.toLowerCase()));
  }

  async updatePullRequestBranch(q: {
    owner: string;
    repo: string;
    prNumber: number;
    expectedHeadSha: string;
  }): Promise<void> {
    await this.run(ghPrUpdateBranchArgv(q.owner, q.repo, String(q.prNumber), q.expectedHeadSha.toLowerCase()));
  }

  private async run(argv: string[]): Promise<string> {
    return this.check(await this.runner(this.binary, argv, { env: ghEnv(this.sourceEnv), timeoutMs: this.timeoutMs }));
  }

  private check(r: GhRunResult): string {
    if (r.notFound) throw new CiStatusError("GH_MISSING", "gh binary not found");
    if (r.timedOut) throw new CiStatusError("TIMEOUT", "gh timed out");
    if (r.exitCode === GH_EXIT_AUTH_REQUIRED) throw new CiStatusError("AUTH_REQUIRED", "gh requires authentication");
    if (r.exitCode !== 0) throw new CiStatusError("GH_FAILED", `gh exited ${r.exitCode ?? "abnormally"}`);
    return r.stdout;
  }

  private parse<T>(stdout: string, fn: (s: string) => T): T {
    try {
      return fn(stdout);
    } catch {
      throw new CiStatusError("PARSE_FAILED", "gh output outside the field allowlist");
    }
  }
}
