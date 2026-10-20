/**
 * The docs-alignment report (T8.10; FR-SKL-11, LLD §20.6). A run whose admitted skills include the example
 * `docs-alignment` skill (`examples/skills/docs-alignment.md`) writes `docs_alignment.json` at its worktree root:
 * `{head_sha, verdict: "aligned" | "conflict", notes}`. After the agent exits, the controller takes the file out of the
 * worktree (so no commit and no push can carry it), checks its shape and stores it as a `docs_alignment` artifact.
 * Delegated choices (not owner-approved), recorded in LLD §20.6:
 *
 * - **Only for that skill.** A run without `docs-alignment` in its `skill_resolved` event is never inspected, so a
 *   repository's own `docs_alignment.json` is left alone everywhere else.
 * - **Untrusted.** The file is agent output. It is read only as a regular file (no symlink) of at most
 *   {@link DOCS_ALIGNMENT_MAX_BYTES}; `notes` goes only into the artifact, redacted when stored, never into an event,
 *   a state or a failure detail. A malformed file is recorded as `valid: false` and stored nowhere.
 * - **Reported, never acted on.** The verdict and the SHA are a run event; nothing is committed, pushed or merged
 *   because of it. A fix is a normal commit through the commit tool on the item's own branch, and the push tool refuses
 *   a protected target (`TARGET_PROTECTED`, LLD §12.6).
 */
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export const DOCS_ALIGNMENT_SKILL = "docs-alignment";
export const DOCS_ALIGNMENT_FILE = "docs_alignment.json";
/** `run_event` type: the report's verdict and SHA (or `valid: false`); never `notes`. */
export const DOCS_ALIGNMENT_EVENT = "docs_alignment";
/** Proposed (Delegated): the largest report read. */
export const DOCS_ALIGNMENT_MAX_BYTES = 16 * 1024;
/** Proposed (Delegated): the longest `notes` kept. */
export const DOCS_ALIGNMENT_NOTES_MAX = 8000;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface DocsAlignmentReport {
  readonly head_sha: string;
  readonly verdict: "aligned" | "conflict";
  readonly notes: string;
}

/** Strict shape check: exactly the three keys, a full lower-case SHA, a known verdict, bounded notes. */
export function parseDocsAlignment(bytes: Buffer): DocsAlignmentReport | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== "head_sha" && k !== "verdict" && k !== "notes")) return undefined;
  if (typeof v.head_sha !== "string" || !SHA.test(v.head_sha)) return undefined;
  if (v.verdict !== "aligned" && v.verdict !== "conflict") return undefined;
  const notes = v.notes ?? "";
  if (typeof notes !== "string" || notes.length > DOCS_ALIGNMENT_NOTES_MAX) return undefined;
  return { head_sha: v.head_sha, verdict: v.verdict, notes };
}

/** True when the run's `skill_resolved` payload names the docs-alignment skill among its admitted entries. */
export function admitsDocsAlignment(skillResolvedPayload: unknown): boolean {
  if (skillResolvedPayload === null || typeof skillResolvedPayload !== "object") return false;
  const entries = (skillResolvedPayload as { entries?: unknown }).entries;
  return (
    Array.isArray(entries) &&
    entries.some((e) => typeof e === "object" && e !== null && (e as { name?: unknown }).name === DOCS_ALIGNMENT_SKILL)
  );
}

export type TakenReport =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly report: DocsAlignmentReport };

/**
 * Take `docs_alignment.json` out of the worktree root: removed whenever it exists (also when it is invalid), parsed
 * only when it is a regular file within the size bound.
 */
export async function takeDocsAlignment(worktree: string): Promise<TakenReport> {
  const file = path.join(worktree, DOCS_ALIGNMENT_FILE);
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(file);
  } catch {
    return { kind: "absent" };
  }
  let bytes: Buffer | undefined;
  if (st.isFile() && st.size <= DOCS_ALIGNMENT_MAX_BYTES) {
    try {
      bytes = await readFile(file);
    } catch {
      bytes = undefined;
    }
  }
  await unlink(file).catch(() => {});
  const report =
    bytes !== undefined && bytes.length <= DOCS_ALIGNMENT_MAX_BYTES ? parseDocsAlignment(bytes) : undefined;
  return report === undefined ? { kind: "invalid" } : { kind: "valid", report };
}
