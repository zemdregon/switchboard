/**
 * Handoff bundle builder, version 1 (T5.4; LLD §15.1, §15.2 and §15.4; ADR-0038 items 1, 5.5 and 7; FR-SES-04,
 * FR-SES-05, FR-TEL-03, NFR-SEC-01, FRD BR-8).
 *
 * {@link assembleHandoffBundle} is PURE: it maps the collected sources (`bundle-sources.ts`), the bounds and a
 * deterministic redactor to the bundle and its exact bytes, with no I/O, no clock and no randomness. So the bundle is a
 * function of `(as_of, bounds, builder_version)` and a rebuild is byte-identical (FR-SES-05). {@link buildHandoffBundle}
 * is collect plus assemble.
 *
 * Text handling, in this order for every text value: redact (FR-TEL-03; before truncation, so a cut can never leave
 * part of a secret that the patterns would no longer match), then cut to its bound at a code point boundary with the
 * marker `[truncated: <n> characters omitted]` (LLD §15.4 rule 2). The canonical JSON (sorted keys, LLD §10) is then
 * redacted once more as a whole, exactly as the artifact store will redact it, and measured against `max_bundle_bytes`;
 * over budget, whole items are dropped in the fixed order of LLD §15.4 rule 3 (extended, see {@link DROP_ORDER}).
 *
 * T16.10 (ADR-0056 item 14, FR-SKL-03): version 2 adds `skills`, the pinned entries of the newest run in `as_of` (the run
 * a continuation follows, LLD §19.5 step 1), taken from that run's controller-written `skill_resolved` event within its
 * watermark: name, version and hash only. Skill text is never a source: the builder reads no skill file and no
 * `run_skill` column beyond what that event carries. Version 1 is still built for a stored version 1 view.
 *
 * T5.14 (FR-SES-07, LLD §20.13): version 3 adds `brief`, the project-brief hash the newest run's admission froze into its
 * project snapshot (`policy_snapshot_json`), or `null`. The brief's file and text are never read. Version 2 is still
 * built for a stored version 2 view; `brief` is never dropped (two short strings).
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../lifecycle/request.js";
import {
  type AsOf,
  BUNDLE_LIMITS,
  BUNDLE_SCHEMA,
  BUNDLE_VERSION,
  BUNDLE_VERSIONS,
  type BundleBounds,
  type BundleBrief,
  type BundleChangedFile,
  type BundleDecision,
  type BundleDiagnosticCommand,
  type BundleDiagnostics,
  type BundleDiffExcerpt,
  type BundleFailedAttempt,
  type BundleOpenWorkItem,
  type BundleReported,
  type BundleRun,
  type BundleSkill,
  type BundleTruncation,
  type BundleVersion,
  checkBounds,
  type HandoffBundle,
  HandoffBundleError,
  type TruncationReason,
} from "./bundle-schema.js";
import { type BundleReadDeps, type BundleSources, collectBundleSources, type SourceRun } from "./bundle-sources.js";
import { deriveOpenWork, type OpenWorkRun } from "./open-work.js";

/** Deterministic redactor (same input, same output), e.g. `ArtifactStore.redactContent`. */
export type BundleRedactor = (content: Buffer) => Buffer;

export interface BuiltBundle {
  readonly bundle: HandoffBundle;
  /** The exact bytes to store: redacted canonical JSON. */
  readonly bytes: Buffer;
  /** SHA-256 (hex) of {@link bytes}; equals the artifact store's content address when it uses the same redactor. */
  readonly sha256: string;
  /** `hex(SHA-256(canonicalJson(as_of)))` (LLD §15.2). */
  readonly asOfSha256: string;
}

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export function asOfSha256(asOf: AsOf): string {
  return sha256Hex(canonicalJson(asOf));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** Byte-wise comparison of two strings' UTF-8 encodings ("sorted by path bytes", LLD §15.1). */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export const truncationMarker = (omitted: number) => `[truncated: ${omitted} characters omitted]`;

/** Keep the first `max` code points; the marker is appended after them (LLD §15.4 rule 2). */
export function cutText(text: string, max: number): { text: string; omitted: number } {
  const points = Array.from(text);
  if (points.length <= max) return { text, omitted: 0 };
  const omitted = points.length - max;
  return { text: `${points.slice(0, max).join("")}${truncationMarker(omitted)}`, omitted };
}

/** Keep the LAST `max` code points (an output tail); the marker comes first. */
export function cutTail(text: string, max: number): { text: string; omitted: number } {
  const points = Array.from(text);
  if (points.length <= max) return { text, omitted: 0 };
  const omitted = points.length - max;
  return { text: `${truncationMarker(omitted)}${points.slice(points.length - max).join("")}`, omitted };
}

/** Keep at most `maxBytes` UTF-8 bytes, cut at a code point boundary; the marker counts omitted code points. */
export function cutBytes(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, omittedBytes: 0 };
  let used = 0;
  let kept = "";
  let keptPoints = 0;
  const points = Array.from(text);
  for (const p of points) {
    const n = Buffer.byteLength(p, "utf8");
    if (used + n > maxBytes) break;
    used += n;
    kept += p;
    keptPoints++;
  }
  return { text: `${kept}${truncationMarker(points.length - keptPoints)}`, omittedBytes: total - used };
}

/** Split `diff-tree -r -z --name-status` output into entries, in Git's order. */
export function parseNameStatusZ(raw: Buffer): BundleChangedFile[] {
  const parts = raw.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length % 2 !== 0) throw new HandoffBundleError("git name-status output is malformed");
  const out: BundleChangedFile[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i] as string;
    if (status !== "A" && status !== "M" && status !== "D" && status !== "T") {
      throw new HandoffBundleError("git name-status output has an unexpected status");
    }
    out.push({ status, path: parts[i + 1] as string });
  }
  return out;
}

/** Split `diff-tree -p` output into one block per file, in Git's order (each block starts at its `diff --git` line). */
export function splitPatch(raw: Buffer): string[] {
  const text = raw.toString("utf8");
  if (text === "") return [];
  const starts: number[] = [];
  if (text.startsWith("diff --git ")) starts.push(0);
  for (let at = text.indexOf("\ndiff --git "); at !== -1; at = text.indexOf("\ndiff --git ", at + 1)) {
    starts.push(at + 1);
  }
  if (starts[0] !== 0) throw new HandoffBundleError("git patch output is malformed");
  return starts.map((s, i) => text.slice(s, starts[i + 1] ?? text.length));
}

/**
 * Rule 3 of LLD §15.4, then the Delegated extension (T5.4): the LLD's seven steps first, in its order; then, because
 * `constraints` (64 values of `max_text_chars`) alone can exceed the 16 KiB minimum, `paths_to_inspect` from the last,
 * `failed_attempts` from the oldest, `open_work` from the last, `constraints` from the last and the whole `diagnostics`.
 * `as_of`, `goal`, `git`, `bounds` and `truncation` are never dropped; if they alone exceed the budget (a meta-session
 * with very many runs makes `as_of` large) the build fails closed with `HANDOFF_BUNDLE_UNAVAILABLE`.
 */
export const DROP_ORDER = [
  "diff_excerpts",
  "diagnostics.output_excerpt",
  "reported",
  "instructions",
  "decisions",
  "runs",
  "changed_files",
  "paths_to_inspect",
  "failed_attempts",
  "open_work",
  "constraints",
  "diagnostics",
  "skills",
] as const;

/** LLD §19.11: the run event that lists a run's pinned skills (written by the lifecycle at admission). */
const SKILL_RESOLVED = "skill_resolved";
/** LLD §19.1 skill names (`src/skills/format.ts` `SKILL_NAME`; not imported: the builder reaches no skills module). */
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

type Mutable = {
  -readonly [K in keyof HandoffBundle]: HandoffBundle[K] extends readonly (infer T)[] ? T[] : HandoffBundle[K];
};

/**
 * The pure assembler. Throws {@link HandoffBundleError} only for inconsistent sources, a redactor failure or no fit.
 * `version` is {@link BUNDLE_VERSION} for a new bundle; 1 or 2 rebuilds a stored view of that version (version 1 has no
 * `skills`, versions 1 and 2 no `brief`).
 */
export function assembleHandoffBundle(
  sources: BundleSources,
  boundsIn: BundleBounds,
  redactor: BundleRedactor,
  version: BundleVersion = BUNDLE_VERSION,
): BuiltBundle {
  if (!(BUNDLE_VERSIONS as readonly unknown[]).includes(version)) {
    throw new HandoffBundleError("unknown bundle version");
  }
  const bounds = checkBounds(boundsIn);
  const redact = (text: string): string => {
    try {
      return redactor(Buffer.from(text, "utf8")).toString("utf8");
    } catch {
      throw new HandoffBundleError("the redactor failed");
    }
  };
  const truncation: BundleTruncation[] = [];
  // One entry per (field, reason), summed: each cut value carries its own marker, and the list stays bounded (a
  // per-value list could itself outgrow the budget, and `truncation` is never dropped).
  const note = (field: string, dropped: number, reason: TruncationReason) => {
    if (dropped <= 0) return;
    const entry = truncation.find((t) => t.field === field && t.reason === reason);
    if (entry === undefined) truncation.push({ field, dropped, reason });
    else (entry as { dropped: number }).dropped += dropped;
  };
  const text = (value: string, max: number, field: string): string => {
    const cut = cutText(redact(value), max);
    note(field, cut.omitted, "text_chars");
    return cut.text;
  };
  const newest = <T>(items: readonly T[], max: number, field: string): T[] => {
    note(field, Math.max(0, items.length - max), "item_limit");
    return items.slice(Math.max(0, items.length - max));
  };
  const first = <T>(items: readonly T[], max: number, field: string): T[] => {
    note(field, Math.max(0, items.length - max), "item_limit");
    return items.slice(0, max);
  };
  const T = bounds.max_text_chars;
  const { asOf } = sources;
  const runs = sources.runs;

  // goal, constraints, instructions (orchestrator text).
  const goal = text(sources.goal, BUNDLE_LIMITS.goalChars, "goal");
  const constraints = first(sources.constraints, BUNDLE_LIMITS.constraints, "constraints").map((c) =>
    text(c, T, "constraints"),
  );
  const instructionSources = runs.flatMap((r) => {
    const request = parseJson(r.record.request_json);
    const objective = isRecord(request) ? request.objective : undefined;
    if (typeof objective !== "string") throw new HandoffBundleError(`run ${r.record.id}: no recorded instruction`);
    return objective === sources.goal ? [] : [{ run_id: r.record.id, text: objective }];
  });
  const instructions = newest(instructionSources, BUNDLE_LIMITS.instructions, "instructions").map((i) => ({
    run_id: i.run_id,
    text: text(i.text, T, "instructions"),
  }));

  // decisions (controller templates), in (created_at, id) order.
  const allDecisions: BundleDecision[] = runs
    .flatMap((r) => r.decisions)
    .map((d) => ({
      id: d.id,
      run_id: d.run_id ?? "",
      kind: d.decision,
      summary: d.reason_summary,
      created_at: d.created_at,
    }))
    .sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    .map(({ run_id, kind, summary, created_at }) => ({ run_id, kind, summary: redact(summary), created_at }));
  const decisions = newest(allDecisions, BUNDLE_LIMITS.decisions, "decisions");

  // runs, failed attempts, open work (controller facts).
  const eventPayloads = (r: SourceRun, type: string) =>
    r.events
      .filter((e) => e.type === type)
      .map((e) => parseJson(e.payload_json))
      .filter(isRecord);
  const verificationOf = (r: SourceRun) => {
    const byIndex = new Map<number, Record<string, unknown>>();
    for (const p of eventPayloads(r, "verification_command")) {
      const index = int(p.index);
      if (index !== null && typeof p.outcome === "string") byIndex.set(index, p);
    }
    return [...byIndex.entries()].sort(([a], [b]) => a - b);
  };
  const requestArgv = (r: SourceRun, index: number): string[] | null => {
    const request = parseJson(r.record.request_json);
    const cmds = isRecord(request) && Array.isArray(request.verification_commands) ? request.verification_commands : [];
    const a = cmds[index];
    return Array.isArray(a) && a.every((x) => typeof x === "string") ? (a as string[]) : null;
  };
  const postOf = (r: SourceRun) => {
    for (const p of eventPayloads(r, "checkpoint"))
      if (p.kind === "post" && typeof p.commit === "string") return p.commit;
    return null;
  };
  const modeOf = (r: SourceRun): BundleRun["mode"] => {
    const d = r.decisions.find((x) => x.decision === "route_selected");
    const m = d === undefined ? null : / mode=(new|resume|handoff) /.exec(d.reason_summary);
    return m === null ? null : (m[1] as BundleRun["mode"]);
  };
  const allRuns: BundleRun[] = runs.map((r) => ({
    run_id: r.record.id,
    parent_run_id: r.record.parent_run_id,
    attempt: r.record.attempt,
    provider: r.record.provider,
    harness: r.binding?.harness ?? null,
    backing_provider: r.binding?.backing_provider ?? null,
    model: r.binding?.model ?? r.record.model,
    trust_profile: r.record.trust_profile,
    state: r.record.state as BundleRun["state"],
    failure_code: r.record.failure_code,
    started_at: r.record.started_at,
    finished_at: r.record.finished_at,
    changed_files: int(r.terminal.changed_files) ?? 0,
    post_commit: postOf(r),
    verification: verificationOf(r).map(([index, p]) => ({
      index,
      outcome: p.outcome as string,
      exit_code: int(p.exit_code),
    })),
    mode: modeOf(r),
  }));
  const bundleRuns = newest(allRuns, BUNDLE_LIMITS.runs, "runs");

  const failedSources = runs.filter((r) => r.record.state !== "SUCCEEDED");
  const keptFailed = newest(failedSources, BUNDLE_LIMITS.failedAttempts, "failed_attempts");
  const failedAttempts: BundleFailedAttempt[] = keptFailed.map((r) => {
    const assessment = eventPayloads(r, "workspace_assessment").at(-1);
    const rollback = eventPayloads(r, "rollback").at(-1);
    return {
      run_id: r.record.id,
      provider: r.record.provider,
      failure_code: r.record.state === "CANCELLED" ? "CANCELLED" : (r.record.failure_code ?? "UNKNOWN"),
      mutated: typeof assessment?.mutated === "boolean" ? assessment.mutated : null,
      evidence_commit: str(rollback?.evidence_commit) ?? postOf(r),
      evidence_diff: r.evidenceDiff,
      head_restored_to: str(rollback?.head),
    };
  });

  const openRuns: OpenWorkRun[] = runs.map((r) => {
    const assessment = eventPayloads(r, "workspace_assessment").at(-1);
    return {
      runId: r.record.id,
      state: r.record.state as OpenWorkRun["state"],
      failureCode: r.record.failure_code,
      verification: verificationOf(r).map(([index, p]) => ({
        index,
        outcome: p.outcome as string,
        argv: requestArgv(r, index),
      })),
      nestedRepositoriesSkipped:
        isRecord(assessment) && Array.isArray(assessment.nested_repositories_skipped)
          ? assessment.nested_repositories_skipped.length
          : 0,
      gitPolicyViolation: r.terminal.git_policy_violation === true,
    };
  });
  const openWork: BundleOpenWorkItem[] = deriveOpenWork(openRuns).map((item) => {
    const d = item.detail;
    if (isRecord(d) && Array.isArray(d.argv)) {
      const argv = (d.argv as string[]).map((a) => text(a, T, "open_work.detail.argv"));
      return { kind: item.kind, run_id: item.run_id, detail: { ...d, argv } };
    }
    return { kind: item.kind, run_id: item.run_id, detail: d };
  });

  // changed files, paths to inspect, diff excerpts (repository text, from Git).
  const gitOrder = parseNameStatusZ(sources.nameStatus);
  const patches = splitPatch(sources.patch);
  if (patches.length !== gitOrder.length) throw new HandoffBundleError("git patch and name-status disagree");
  const sorted = gitOrder
    .map((f, i) => ({ status: f.status, path: f.path, patch: patches[i] as string }))
    .sort((a, b) => compareBytes(a.path, b.path));
  const changedFiles = first(
    sorted.map((f) => ({ status: f.status, path: redact(f.path) })),
    BUNDLE_LIMITS.changedFiles,
    "changed_files",
  );

  const candidatePaths = [
    ...sorted.slice(0, BUNDLE_LIMITS.pathsFromChangedFiles).map((f) => f.path),
    ...keptFailed.flatMap((r) => (r.changedFiles ?? []).map((f) => f.path)),
  ].map(redact);
  const uniquePaths = [...new Set(candidatePaths)].sort(compareBytes);
  const pathsToInspect = first(uniquePaths, BUNDLE_LIMITS.pathsToInspect, "paths_to_inspect");

  const diffExcerpts: BundleDiffExcerpt[] = [];
  let remaining = bounds.max_diff_excerpt_bytes;
  for (const [i, f] of sorted.entries()) {
    if (remaining <= 0) {
      note("diff_excerpts", sorted.length - i, "diff_total_bytes");
      break;
    }
    const redacted = redact(f.patch);
    const perFile = Math.min(BUNDLE_LIMITS.diffExcerptFileBytes, remaining);
    const cut = cutBytes(redacted, perFile);
    const reason: TruncationReason =
      perFile < BUNDLE_LIMITS.diffExcerptFileBytes && Buffer.byteLength(redacted, "utf8") > perFile
        ? "diff_total_bytes"
        : "diff_file_bytes";
    note("diff_excerpts.text", cut.omittedBytes, reason);
    remaining -= Buffer.byteLength(redacted, "utf8") - cut.omittedBytes;
    diffExcerpts.push({ path: redact(f.path), text: cut.text, truncated: cut.omittedBytes > 0 });
  }

  // diagnostics: the newest run that ran verification.
  let diagnostics: BundleDiagnostics | null = null;
  const diagRun = runs.findLast((r) => verificationOf(r).length > 0);
  if (diagRun !== undefined) {
    const report = new Map((diagRun.testReport ?? []).map((c) => [c.index, c]));
    const commands = first(verificationOf(diagRun), BUNDLE_LIMITS.diagnosticsCommands, "diagnostics.commands");
    diagnostics = {
      run_id: diagRun.record.id,
      commands: commands.map(([index, p]): BundleDiagnosticCommand => {
        const argv = requestArgv(diagRun, index);
        const out = report.get(index);
        const tail = (value: string, stream: string) => {
          const cut = cutTail(redact(value), T);
          note(`diagnostics.commands.output_excerpt.${stream}`, cut.omitted, "text_chars");
          return cut.text;
        };
        return {
          index,
          argv: argv === null ? null : argv.map((a) => text(a, T, "diagnostics.commands.argv")),
          outcome: p.outcome as string,
          exit_code: int(p.exit_code),
          signal: str(p.signal),
          duration_ms: int(p.duration_ms),
          output_excerpt:
            out === undefined ? null : { stdout: tail(out.stdout, "stdout"), stderr: tail(out.stderr, "stderr") },
        };
      }),
    };
  }

  // reported (provider text), newest 10 runs that reported anything.
  const reportedRuns = newest(
    runs.filter((r) => typeof r.terminal.summary === "string" || r.record.failure_detail !== null),
    BUNDLE_LIMITS.reportedRuns,
    "reported",
  );
  const reported: BundleReported[] = reportedRuns.flatMap((r) => {
    const out: BundleReported[] = [];
    const id = r.record.id;
    if (typeof r.terminal.summary === "string") {
      out.push({
        run_id: id,
        provider: r.record.provider,
        field: "summary",
        text: text(r.terminal.summary, T, "reported.summary"),
      });
    }
    if (r.record.failure_detail !== null) {
      out.push({
        run_id: id,
        provider: r.record.provider,
        field: "failure_detail",
        text: text(r.record.failure_detail, T, "reported.failure_detail"),
      });
    }
    return out;
  });

  // skills (controller facts, version 2): the newest run's pinned entries, from its `skill_resolved` event.
  const previous = runs.at(-1);
  const resolved = previous === undefined ? undefined : eventPayloads(previous, SKILL_RESOLVED).at(-1);
  const pinned = resolved === undefined ? [] : skillsOf(resolved, (previous as SourceRun).record.id);
  const skills = first(pinned, BUNDLE_LIMITS.skills, "skills");
  // brief (controller fact, version 3): the hash the newest run's admission froze into its project snapshot.
  const brief = previous === undefined ? null : briefOf(previous);

  const bundle: Mutable = {
    schema: BUNDLE_SCHEMA,
    version,
    builder_version: version,
    as_of: asOf,
    bounds,
    goal,
    constraints,
    instructions,
    decisions,
    git: { base_commit: asOf.base_commit, head_commit: asOf.head_commit },
    runs: bundleRuns,
    failed_attempts: failedAttempts,
    open_work: openWork,
    changed_files: changedFiles,
    paths_to_inspect: pathsToInspect,
    diagnostics,
    diff_excerpts: diffExcerpts,
    reported,
    ...(version === 1 ? {} : { skills }),
    ...(version === 3 ? { brief } : {}),
    truncation,
  };
  return fitToBudget(bundle, bounds, redactor);
}

/**
 * The entries of a `skill_resolved` payload as bundle facts: `name`, `version` and `sha256` are copied and every other
 * key (`source`, and anything a later payload adds) is left out. A malformed entry is an inconsistent record (fail closed).
 */
function skillsOf(payload: Record<string, unknown>, runId: string): BundleSkill[] {
  const entries = payload.entries;
  if (!Array.isArray(entries)) throw new HandoffBundleError(`run ${runId}: skill_resolved has no entries`);
  return entries.map((e) => {
    if (
      !isRecord(e) ||
      typeof e.name !== "string" ||
      !SKILL_NAME_RE.test(e.name) ||
      int(e.version) === null ||
      (e.version as number) < 1 ||
      typeof e.sha256 !== "string" ||
      !SHA256_RE.test(e.sha256)
    ) {
      throw new HandoffBundleError(`run ${runId}: skill_resolved has a malformed entry`);
    }
    return { run_id: runId, name: e.name, version: e.version as number, sha256: e.sha256 };
  });
}

/**
 * T5.14: the run's frozen `project.brief_sha256` as a bundle fact, or `null` for a run without one. A snapshot that is
 * not JSON, or a hash that is not 64 lower-case hex digits, is an inconsistent record (fail closed).
 */
function briefOf(run: SourceRun): BundleBrief | null {
  const snapshot = parseJson(run.record.policy_snapshot_json);
  if (!isRecord(snapshot)) throw new HandoffBundleError(`run ${run.record.id}: policy snapshot is malformed`);
  const sha = isRecord(snapshot.project) ? snapshot.project.brief_sha256 : undefined;
  if (sha === undefined) return null;
  if (typeof sha !== "string" || !SHA256_RE.test(sha)) {
    throw new HandoffBundleError(`run ${run.record.id}: brief_sha256 is malformed`);
  }
  return { run_id: run.record.id, sha256: sha };
}

function serialise(bundle: Mutable, redactor: BundleRedactor): Buffer {
  try {
    return redactor(Buffer.from(canonicalJson(bundle), "utf8"));
  } catch {
    throw new HandoffBundleError("the redactor failed");
  }
}

/** LLD §15.4 rule 3: drop whole items in {@link DROP_ORDER} until the redacted canonical JSON fits. */
function fitToBudget(bundle: Mutable, bounds: BundleBounds, redactor: BundleRedactor): BuiltBundle {
  const order = bundle.skills === undefined ? DROP_ORDER.filter((s) => s !== "skills") : DROP_ORDER;
  const drops = new Map<string, BundleTruncation>();
  const dropOne = (step: (typeof DROP_ORDER)[number]): boolean => {
    let field: string = step;
    switch (step) {
      case "diff_excerpts":
        if (bundle.diff_excerpts.pop() === undefined) return false;
        break;
      case "diagnostics.output_excerpt": {
        const cmds = bundle.diagnostics?.commands ?? [];
        const idx = cmds.findLastIndex((c) => c.output_excerpt !== null);
        if (bundle.diagnostics === null || idx < 0) return false;
        const copy = [...cmds];
        copy[idx] = { ...(copy[idx] as BundleDiagnosticCommand), output_excerpt: null };
        bundle.diagnostics = { ...bundle.diagnostics, commands: copy };
        field = "diagnostics.commands.output_excerpt";
        break;
      }
      case "reported":
      case "instructions":
      case "decisions":
      case "runs":
      case "failed_attempts":
        if ((bundle[step] as unknown[]).shift() === undefined) return false;
        break;
      case "changed_files":
      case "paths_to_inspect":
      case "open_work":
      case "constraints":
        if ((bundle[step] as unknown[]).pop() === undefined) return false;
        break;
      case "skills":
        if (bundle.skills === undefined || (bundle.skills as BundleSkill[]).pop() === undefined) return false;
        break;
      case "diagnostics":
        if (bundle.diagnostics === null) return false;
        bundle.diagnostics = null;
        break;
    }
    const entry = drops.get(field);
    if (entry === undefined) {
      const created = { field, dropped: 1, reason: "bundle_bytes" as const };
      drops.set(field, created);
      bundle.truncation.push(created);
    } else {
      (entry as { dropped: number }).dropped++;
    }
    return true;
  };

  let bytes = serialise(bundle, redactor);
  let step = 0;
  while (bytes.length > bounds.max_bundle_bytes) {
    const name = order[step];
    if (name === undefined) throw new HandoffBundleError("the bundle does not fit max_bundle_bytes");
    if (!dropOne(name)) {
      step++;
      continue;
    }
    bytes = serialise(bundle, redactor);
  }
  // The whole-document redaction must leave valid JSON (fail closed if a pattern ever spans JSON structure).
  if (parseJson(bytes.toString("utf8")) === undefined) throw new HandoffBundleError("the redacted bundle is not JSON");
  return { bundle: bundle as HandoffBundle, bytes, sha256: sha256Hex(bytes), asOfSha256: asOfSha256(bundle.as_of) };
}

export interface BuildDeps extends BundleReadDeps {
  /** The artifact store's redactor (`ArtifactStore.redactContent`), so the bytes measured are the bytes stored. */
  readonly redact: BundleRedactor;
}

/**
 * Collect the sources at `asOf` and assemble the bundle (LLD §15.2). Throws {@link HandoffBundleError} on failure.
 * `version` defaults to {@link BUNDLE_VERSION}; {@link regenerateHandoffBundle} passes a stored view's own version.
 */
export async function buildHandoffBundle(
  deps: BuildDeps,
  asOf: AsOf,
  bounds: BundleBounds,
  version: BundleVersion = BUNDLE_VERSION,
): Promise<BuiltBundle> {
  const checked = checkBounds(bounds);
  const sources = await collectBundleSources(deps, asOf);
  return assembleHandoffBundle(sources, checked, deps.redact, version);
}

/**
 * Regenerate a stored view (FR-SES-05): rebuild from the `as_of`, `bounds` and version recorded in its bytes, with that
 * version's builder (version 1, 2 or 3). The result is byte-identical to the stored view when the records are intact.
 */
export async function regenerateHandoffBundle(deps: BuildDeps, storedView: Buffer): Promise<BuiltBundle> {
  const parsed = parseJson(storedView.toString("utf8"));
  if (
    !isRecord(parsed) ||
    parsed.schema !== BUNDLE_SCHEMA ||
    !(BUNDLE_VERSIONS as readonly unknown[]).includes(parsed.builder_version) ||
    parsed.version !== parsed.builder_version
  ) {
    throw new HandoffBundleError("the stored view is not a bundle of a known version");
  }
  if (!isRecord(parsed.as_of) || !isRecord(parsed.bounds)) throw new HandoffBundleError("the stored view is malformed");
  return buildHandoffBundle(
    deps,
    parsed.as_of as unknown as AsOf,
    parsed.bounds as unknown as BundleBounds,
    parsed.version as BundleVersion,
  );
}
