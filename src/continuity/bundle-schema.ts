/**
 * Handoff bundle, schema version 2 (T5.4, T16.10; LLD §15.1 to §15.4, ADR-0038 items 1, 2, 5.5 and 7, ADR-0056 item 14;
 * FR-SES-04, FR-SES-05, FR-SKL-03). Types, constants and the one failure type. PURE: no I/O and no imports.
 *
 * Version 2 adds `skills` (the previous run's pinned skills as controller facts: name, version, hash; never text) and is
 * otherwise version 1. Version 1 stays buildable and readable (ADR-0038 "Regenerability"; FR-SES-05): a view stored as
 * version 1 regenerates byte-identically as version 1 ({@link BundleVersion}).
 *
 * Every field is always present; an empty list or `null` means "none". Text classes (LLD §15.1): `controller` (ids,
 * codes, counts, SHAs, timestamps, decision templates), `orchestrator` (goal, constraints, instructions, verification
 * argv), `provider_reported` (`reported`) and `repository` (paths, diff excerpts, verification output). The renderer
 * (T5.5) shows only the last two as untrusted data; this module only carries them.
 */

export const BUNDLE_SCHEMA = "switchboard.handoff_bundle";
/** The version a new bundle is built with; `version` and `builder_version` move together. */
export const BUNDLE_VERSION = 2;
export const BUILDER_VERSION = 2;
/** Every version this builder can build and the renderer can read. */
export const BUNDLE_VERSIONS = [1, 2] as const;
export type BundleVersion = (typeof BUNDLE_VERSIONS)[number];

/** The three configurable bounds (ADR-0038 item 5.5; every default is an **Assumption**, no measurement exists). */
export interface BundleBounds {
  /** Canonical JSON of the whole bundle, after redaction. */
  readonly max_bundle_bytes: number;
  /** All `diff_excerpts[].text` together (UTF-8 bytes, markers excluded). */
  readonly max_diff_excerpt_bytes: number;
  /** Each `constraints`, `instructions`, `reported` and `output_excerpt` value (Unicode code points). */
  readonly max_text_chars: number;
}

export const DEFAULT_BUNDLE_BOUNDS: BundleBounds = Object.freeze({
  max_bundle_bytes: 65536,
  max_diff_excerpt_bytes: 32768,
  max_text_chars: 2000,
});

/** LLD §15.4: the configured `max_bundle_bytes` may not go below this. */
export const MIN_BUNDLE_BYTES = 16384;

/** Constant bounds of LLD §15.1 and §15.4 (**Assumptions** of T5.1). */
export const BUNDLE_LIMITS = Object.freeze({
  goalChars: 8000,
  constraints: 64,
  instructions: 10,
  decisions: 100,
  runs: 20,
  failedAttempts: 10,
  changedFiles: 500,
  pathsFromChangedFiles: 40,
  pathsToInspect: 50,
  diagnosticsCommands: 8,
  diffExcerptFileBytes: 4096,
  reportedRuns: 10,
  /** T16.10: the highest `skills.max_per_run` (LLD §19.3), so admission can never pin more than this. */
  skills: 64,
});

export interface AsOfRun {
  readonly run_id: string;
  readonly last_seq: number;
}

/** LLD §15.2: the exact record set a bundle is a pure function of. */
export interface AsOf {
  readonly meta_session_id: string;
  readonly base_commit: string;
  readonly head_commit: string;
  /** Every terminal run of the meta-session at build time, in `(created_at, id)` order. */
  readonly runs: readonly AsOfRun[];
}

export interface BundleDecision {
  readonly run_id: string;
  readonly kind: string;
  readonly summary: string;
  readonly created_at: string;
}

export interface BundleVerificationOutcome {
  readonly index: number;
  readonly outcome: string;
  readonly exit_code: number | null;
}

export interface BundleRun {
  readonly run_id: string;
  readonly parent_run_id: string | null;
  readonly attempt: number;
  readonly provider: string | null;
  readonly harness: string | null;
  readonly backing_provider: string | null;
  readonly model: string | null;
  readonly trust_profile: string;
  readonly state: "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly failure_code: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly changed_files: number;
  readonly post_commit: string | null;
  readonly verification: readonly BundleVerificationOutcome[];
  readonly mode: "new" | "resume" | "handoff" | null;
}

/** BR-8: a failed attempt names its failure code and its evidence diff artifact by id and hash; the diff is not read. */
export interface BundleFailedAttempt {
  readonly run_id: string;
  readonly provider: string | null;
  /** The run's failure code, or `CANCELLED`. */
  readonly failure_code: string;
  readonly mutated: boolean | null;
  readonly evidence_commit: string | null;
  readonly evidence_diff: { readonly artifact_id: string; readonly sha256: string } | null;
  readonly head_restored_to: string | null;
}

export interface BundleOpenWorkItem {
  readonly kind: string;
  readonly run_id: string;
  readonly detail: unknown;
}

export interface BundleChangedFile {
  readonly status: "A" | "M" | "D" | "T";
  readonly path: string;
}

export interface BundleOutputExcerpt {
  readonly stdout: string;
  readonly stderr: string;
}

export interface BundleDiagnosticCommand {
  readonly index: number;
  readonly argv: readonly string[] | null;
  readonly outcome: string;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly duration_ms: number | null;
  /** Tails of the command's stdout and stderr from the run's `test_report` artifact; `null` when none or dropped. */
  readonly output_excerpt: BundleOutputExcerpt | null;
}

export interface BundleDiagnostics {
  readonly run_id: string;
  readonly commands: readonly BundleDiagnosticCommand[];
}

export interface BundleDiffExcerpt {
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface BundleReported {
  readonly run_id: string;
  readonly provider: string | null;
  readonly field: "summary" | "failure_detail";
  readonly text: string;
}

/**
 * One pinned skill of the previous run (T16.10, ADR-0056 item 14): controller facts only. The body, the description and
 * the delivery mode are never in the bundle; the successor re-delivers from its own `run_skill` rows (LLD §19.5 step 1).
 */
export interface BundleSkill {
  readonly run_id: string;
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
}

/** One cut or drop (LLD §15.4). `dropped` counts items, code points or bytes, as `reason` says. */
export interface BundleTruncation {
  readonly field: string;
  readonly dropped: number;
  readonly reason: TruncationReason;
}

export type TruncationReason = "item_limit" | "text_chars" | "diff_file_bytes" | "diff_total_bytes" | "bundle_bytes";

export interface HandoffBundle {
  readonly schema: typeof BUNDLE_SCHEMA;
  readonly version: BundleVersion;
  readonly builder_version: BundleVersion;
  readonly as_of: AsOf;
  readonly bounds: BundleBounds;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly instructions: readonly { readonly run_id: string; readonly text: string }[];
  readonly decisions: readonly BundleDecision[];
  readonly git: { readonly base_commit: string; readonly head_commit: string };
  readonly runs: readonly BundleRun[];
  readonly failed_attempts: readonly BundleFailedAttempt[];
  readonly open_work: readonly BundleOpenWorkItem[];
  readonly changed_files: readonly BundleChangedFile[];
  readonly paths_to_inspect: readonly string[];
  readonly diagnostics: BundleDiagnostics | null;
  readonly diff_excerpts: readonly BundleDiffExcerpt[];
  readonly reported: readonly BundleReported[];
  /** Version 2 only (always present there, empty for a previous run without skills); absent in version 1. */
  readonly skills?: readonly BundleSkill[];
  readonly truncation: readonly BundleTruncation[];
}

/** The FR-SES-04 list mapped onto bundle fields (ADR-0038 item 1.1), for the "present or explicitly empty" check. */
export const FR_SES_04_FIELDS = [
  "goal",
  "constraints",
  "decisions",
  "git",
  "changed_files",
  "diff_excerpts",
  "diagnostics",
  "failed_attempts",
  "open_work",
  "paths_to_inspect",
] as const;

/** Every top-level field of version 1 (LLD §15.1). */
export const BUNDLE_FIELDS_V1 = [
  "schema",
  "version",
  "builder_version",
  "as_of",
  "bounds",
  "goal",
  "constraints",
  "instructions",
  "decisions",
  "git",
  "runs",
  "failed_attempts",
  "open_work",
  "changed_files",
  "paths_to_inspect",
  "diagnostics",
  "diff_excerpts",
  "reported",
  "truncation",
] as const;

/** Every top-level field of version 2 (LLD §15.1): version 1 plus `skills`. */
export const BUNDLE_FIELDS = [...BUNDLE_FIELDS_V1, "skills"] as const;

/** The top-level fields of `version`. */
export const bundleFieldsOf = (version: BundleVersion): readonly string[] =>
  version === 1 ? BUNDLE_FIELDS_V1 : BUNDLE_FIELDS;

export const HANDOFF_BUNDLE_UNAVAILABLE = "HANDOFF_BUNDLE_UNAVAILABLE";
/** ADR-0038 item 7: one fixed message; the cause stays in `cause` for the operator log, never in the envelope. */
export const HANDOFF_BUNDLE_UNAVAILABLE_MESSAGE = "the handoff bundle could not be built from the controller's records";

/**
 * The one bundle failure (ADR-0038 item 7, LLD §15.7 step 5): maps to `TOOL_FAILURE`, `retryable: false`,
 * `details.reason = "HANDOFF_BUNDLE_UNAVAILABLE"`. Thrown before anything is written. Truncation never throws it.
 */
export class HandoffBundleError extends Error {
  override readonly name = "HandoffBundleError";
  readonly code = "TOOL_FAILURE" as const;
  readonly retryable = false as const;
  readonly details = Object.freeze({ reason: HANDOFF_BUNDLE_UNAVAILABLE });
  /** Controller-side cause (a record id, a Git step); for logs and tests only. */
  readonly internalCause: string;

  constructor(internalCause: string) {
    super(HANDOFF_BUNDLE_UNAVAILABLE_MESSAGE);
    this.internalCause = internalCause;
  }
}

/** Validate operator-supplied bounds (LLD §15.4). Throws {@link HandoffBundleError} on a value it cannot honour. */
export function checkBounds(bounds: BundleBounds): BundleBounds {
  const ok = (v: unknown, min: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
  if (
    !ok(bounds.max_bundle_bytes, MIN_BUNDLE_BYTES) ||
    !ok(bounds.max_diff_excerpt_bytes, 0) ||
    !ok(bounds.max_text_chars, 1)
  ) {
    throw new HandoffBundleError("bundle bounds are invalid");
  }
  return {
    max_bundle_bytes: bounds.max_bundle_bytes,
    max_diff_excerpt_bytes: bounds.max_diff_excerpt_bytes,
    max_text_chars: bounds.max_text_chars,
  };
}
