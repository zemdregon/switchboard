/**
 * Production {@link CiStatusPort} (T15.3; ADR-0050): runs the operator's logged-in `gh` as an external subprocess with
 * an argv from the closed allowlist (`gh-argv.ts`), no shell, an allowlisted environment and a wall-clock bound. Only
 * allowlisted JSON fields are read; stderr is discarded and no `gh` output reaches an error message, log or the ledger.
 * Tests inject {@link GhRunner}; CI never runs a real `gh`.
 */
import { execFile } from "node:child_process";
import {
  branchOfPublishRef,
  ghCheckRunsArgv,
  ghEnv,
  ghRunListArgv,
  ghRunViewArgv,
  isFullLowerSha,
  parseCheckRuns,
  parseRunList,
  parseRunView,
} from "./gh-argv.js";
import {
  type CiConclusion,
  CiStatusError,
  type CiStatusObservation,
  type CiStatusPort,
  type CiStatusQuery,
} from "./port.js";

/** `gh` exit code for "authentication required" (`gh help exit-codes`). */
export const GH_EXIT_AUTH_REQUIRED = 4;
export const DEFAULT_GH_TIMEOUT_MS = 30_000;
const MAX_GH_STDOUT_BYTES = 1024 * 1024;

export interface GhRunResult {
  /** Exit code, or null when the process was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut?: boolean;
  /** The binary was not found. */
  readonly notFound?: boolean;
}

export type GhRunner = (
  binary: string,
  argv: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number },
) => Promise<GhRunResult>;

/** Default runner: `execFile` (never a shell), stdout capped, stderr dropped. */
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
      (err, stdout) => {
        if (err === null) return resolve({ exitCode: 0, stdout: String(stdout) });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null };
        if (e.code === "ENOENT") return resolve({ exitCode: null, stdout: "", notFound: true });
        if (e.killed === true || e.signal === "SIGKILL") return resolve({ exitCode: null, stdout: "", timedOut: true });
        resolve({ exitCode: typeof e.code === "number" ? e.code : 1, stdout: String(stdout ?? "") });
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

export class GhCiStatusPort implements CiStatusPort {
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

  private async run(argv: string[]): Promise<string> {
    const r = await this.runner(this.binary, argv, { env: ghEnv(this.sourceEnv), timeoutMs: this.timeoutMs });
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
