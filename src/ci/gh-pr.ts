/**
 * The pull-request port of MCP `publish_run` (ADR-0069; LLD §3.4.12; audited `gh` argv per ADR-0050 and ADR-0037).
 * Production {@link GhPullRequestPort} runs the operator's logged-in `gh` with an argv from the closed allowlist
 * (`gh-argv.ts` G13 and G14; G16 and G17 for MCP `close_pr`, ADR-0078), no shell, the allowlisted environment of
 * `ghEnv` (never a token variable) and a wall-clock bound. stdout is read only through the G13/G14/G17 parsers, which
 * keep a number, a state, a URL that must have the exact `https://github.com/<owner>/<repo>/pull/<n>` shape and (G17) a
 * safe head branch name. Errors carry a closed code; ADR-0095: a `GH_FAILED` also carries {@link GhFailureDetail}, the
 * exit code, a closed reason classified from stderr and a sanitised one-line stderr excerpt (secret rules redacted,
 * control characters removed, capped). stderr is read for nothing else.
 * Tests inject {@link PullRequestPort} or a {@link GhRunner}; CI never runs a real `gh`.
 */

import { defaultRedactor } from "../artifacts/redact.js";
import {
  ghEnv,
  ghPrCloseArgv,
  ghPrCreateArgv,
  ghPrLinkViewArgv,
  ghPrNumberViewArgv,
  parsePrCreated,
  parsePrLinkView,
  parsePrNumberView,
} from "./gh-argv.js";
import { DEFAULT_GH_TIMEOUT_MS, execGh, GH_EXIT_AUTH_REQUIRED, type GhRunner, type GhRunResult } from "./gh-port.js";

/** Closed failure codes of the port; `publish_run` reports one of them as `pull_request_error`. */
export const PULL_REQUEST_ERRORS = ["GH_MISSING", "AUTH_REQUIRED", "TIMEOUT", "GH_FAILED", "PARSE_FAILED"] as const;
export type PullRequestErrorCode = (typeof PULL_REQUEST_ERRORS)[number];

/** ADR-0095: closed reasons a `GH_FAILED` is classified into from `gh`'s stderr (Delegated vocabulary). */
export const GH_FAILURE_REASONS = [
  "HEAD_BRANCH_MISSING",
  "BASE_BRANCH_MISSING",
  "NO_COMMITS",
  "PULL_REQUEST_EXISTS",
  "RATE_LIMITED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "NETWORK",
  "VALIDATION_FAILED",
  "UNKNOWN",
] as const;
export type GhFailureReason = (typeof GH_FAILURE_REASONS)[number];

/** ADR-0095: most characters of {@link GhFailureDetail.message}. */
export const GH_FAILURE_MESSAGE_MAX = 300;

/** ADR-0095: why `gh` failed, safe to return to an MCP client. */
export interface GhFailureDetail {
  /** `gh`'s exit code, or null when it ended abnormally. */
  readonly exit_code: number | null;
  readonly reason: GhFailureReason;
  /** Sanitised stderr excerpt: secret rules redacted, one line, printable characters only, capped; may be empty. */
  readonly message: string;
}

// First match wins: GitHub reports a deleted head as "Head sha can't be blank, ..., No commits between ..., Head ref
// must be a branch", so the head checks come before NO_COMMITS.
const REASON_PATTERNS: readonly [GhFailureReason, RegExp][] = [
  ["HEAD_BRANCH_MISSING", /head ref must be a branch|head sha can't be blank|could not find.*head/iu],
  ["BASE_BRANCH_MISSING", /base ref must be a branch|base sha can't be blank|could not find.*base/iu],
  ["NO_COMMITS", /no commits between/iu],
  ["PULL_REQUEST_EXISTS", /pull request for branch .* already exists|pull request already exists/iu],
  ["RATE_LIMITED", /rate limit|secondary rate|abuse detection|HTTP 429/iu],
  ["PERMISSION_DENIED", /resource not accessible|must have (?:push|write|admin) access|permission|HTTP 403/iu],
  ["NOT_FOUND", /could not resolve to a repository|not found|HTTP 404/iu],
  [
    "NETWORK",
    /dial tcp|connection (?:refused|reset)|i\/o timeout|no such host|TLS handshake|unexpected EOF|HTTP 50[234]/iu,
  ],
  ["VALIDATION_FAILED", /validation failed|unprocessable|HTTP 422/iu],
];

/** ADR-0095: the closed reason and the sanitised excerpt of a non-zero `gh` exit (the stderr tail of {@link execGh}). */
export function ghFailureDetail(exitCode: number | null, stderr: string | undefined): GhFailureDetail {
  const raw = defaultRedactor(Buffer.from(stderr ?? "", "utf8")).toString("utf8");
  const reason = REASON_PATTERNS.find(([, re]) => re.test(raw))?.[0] ?? "UNKNOWN";
  const lines = raw
    .split(/\r?\n/u)
    .map((l) =>
      l
        .replace(/[^\x20-\x7e]/gu, " ")
        .replace(/ {2,}/gu, " ")
        .trim(),
    )
    .filter((l) => l !== "");
  let message = lines.join(" | ");
  if (message.length > GH_FAILURE_MESSAGE_MAX) message = `${message.slice(0, GH_FAILURE_MESSAGE_MAX - 3)}...`;
  return { exit_code: exitCode, reason, message };
}

export class PullRequestPortError extends Error {
  override readonly name = "PullRequestPortError";
  constructor(
    readonly code: PullRequestErrorCode,
    message: string,
    /** ADR-0095: present on a `GH_FAILED` from a non-zero exit. */
    readonly detail?: GhFailureDetail,
  ) {
    super(message);
  }
}

export interface PullRequestLink {
  readonly number: number;
  /** `OPEN`, `CLOSED`, `MERGED` as `gh` reports it (upper-case word). */
  readonly state: string;
  readonly url: string;
}

/** ADR-0078: a pull request read by number (G17). */
export interface PullRequestByNumber extends PullRequestLink {
  readonly headBranch: string;
}

export interface PullRequestPort {
  /** G14: the pull request whose head is `branch`, or null when it has none (`gh pr view` exit 1). */
  findForBranch(q: { owner: string; repo: string; branch: string }): Promise<PullRequestLink | null>;
  /** G13: open one; returns its number and URL. */
  create(q: {
    owner: string;
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }>;
  /**
   * ADR-0078 (MCP `close_pr`): G17, pull request `number` with its head branch, or null when it has none (exit 1).
   * Optional, as {@link close}; `close_pr` is offered only when both are present.
   */
  findByNumber?(q: { owner: string; repo: string; number: number }): Promise<PullRequestByNumber | null>;
  /**
   * ADR-0078 (MCP `close_pr`): G16, close one pull request with a controller-built comment, optionally deleting its
   * branch. Optional so ports without it keep compiling; `close_pr` is offered only when it is present.
   */
  close?(q: { owner: string; repo: string; number: number; comment: string; deleteBranch: boolean }): Promise<void>;
}

export interface GhPullRequestPortOptions {
  /** `ci_trigger.gh_binary` (default `gh`, resolved on PATH). */
  readonly binary?: string;
  readonly runner?: GhRunner;
  /** Environment the allowlisted variables are copied from (default `process.env`). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

export class GhPullRequestPort implements PullRequestPort {
  private readonly binary: string;
  private readonly runner: GhRunner;
  private readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;

  constructor(options: GhPullRequestPortOptions = {}) {
    this.binary = options.binary ?? "gh";
    this.runner = options.runner ?? execGh;
    this.sourceEnv = options.sourceEnv ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  }

  async findForBranch(q: { owner: string; repo: string; branch: string }): Promise<PullRequestLink | null> {
    const r = await this.spawn(ghPrLinkViewArgv(q.owner, q.repo, q.branch));
    // As G9: `gh pr view` exits 1 when the branch has no pull request; stderr is not consulted here.
    if (r.exitCode === 1 && r.notFound !== true && r.timedOut !== true) return null;
    return parsed(() => parsePrLinkView(check(r), q.owner, q.repo));
  }

  async create(q: {
    owner: string;
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }> {
    const r = await this.spawn(ghPrCreateArgv(q.owner, q.repo, q.branch, q.base, q.title, q.body, q.draft));
    return parsed(() => parsePrCreated(check(r), q.owner, q.repo));
  }

  async findByNumber(q: { owner: string; repo: string; number: number }): Promise<PullRequestByNumber | null> {
    const r = await this.spawn(ghPrNumberViewArgv(q.owner, q.repo, String(q.number)));
    if (r.exitCode === 1 && r.notFound !== true && r.timedOut !== true) return null;
    return parsed(() => {
      const v = parsePrNumberView(check(r), q.owner, q.repo);
      return { number: v.number, state: v.state, url: v.url, headBranch: v.headRefName };
    });
  }

  async close(q: {
    owner: string;
    repo: string;
    number: number;
    comment: string;
    deleteBranch: boolean;
  }): Promise<void> {
    const r = await this.spawn(ghPrCloseArgv(q.owner, q.repo, String(q.number), q.comment, q.deleteBranch));
    check(r); // stdout is never read: success is the exit code
  }

  private spawn(argv: string[]): Promise<GhRunResult> {
    return this.runner(this.binary, argv, { env: ghEnv(this.sourceEnv), timeoutMs: this.timeoutMs });
  }
}

function check(r: GhRunResult): string {
  if (r.notFound) throw new PullRequestPortError("GH_MISSING", "gh binary not found");
  if (r.timedOut) throw new PullRequestPortError("TIMEOUT", "gh timed out");
  if (r.exitCode === GH_EXIT_AUTH_REQUIRED)
    throw new PullRequestPortError("AUTH_REQUIRED", "gh requires authentication");
  if (r.exitCode !== 0) {
    const detail = ghFailureDetail(r.exitCode, r.stderr);
    throw new PullRequestPortError("GH_FAILED", `gh exited ${r.exitCode ?? "abnormally"} (${detail.reason})`, detail);
  }
  return r.stdout;
}

function parsed<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PullRequestPortError) throw err;
    throw new PullRequestPortError("PARSE_FAILED", "gh output outside the field allowlist");
  }
}
