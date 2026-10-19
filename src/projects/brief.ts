/**
 * Project brief (T5.14; FR-SES-07, FR-SES-04, LLD §20.13, ADR-0038). `projects[].brief_file` names an operator-maintained
 * text file (goal, definition of done, known failures) outside every allowed root and every context of the project, so
 * no agent working in a worktree can edit its own brief. It is at most {@link MAX_BRIEF_BYTES} bytes of UTF-8.
 *
 * Lifecycle of one brief (Linus decisions, WORK QUEUE v10, Delegated, not owner-approved):
 * 1. **Config load** (`loadConfig`): the file is read once; a missing, unreadable, empty, oversized, non-UTF-8 or
 *    in-root file, or one whose labelled block alone exceeds `rag.retrieval.max_context_tokens`, aborts startup.
 * 2. **Admission** ({@link freezeBrief}): the file is read again and the run is refused (`TOOL_FAILURE`,
 *    `PROJECT_BRIEF_UNAVAILABLE`) if it fails any rule (fail closed, never skipped). Its SHA-256 is frozen into the run's
 *    project snapshot (`brief_sha256`) and its text is kept in this process by hash, so an edit after admission does not
 *    change that run.
 * 3. **Dispatch** ({@link frozenBrief}): the text is taken by hash; after a restart the file is re-read and used only if
 *    its hash still matches, else the run fails closed.
 *
 * The text never reaches the ledger, an artifact, a log or the handoff bundle; only its hash does. Nothing here imports
 * the retrieval service (FR-RAG-07): the token estimate is the same controller approximation (UTF-8 bytes / 4).
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** LLD §20.13: the largest brief file, in bytes. */
export const MAX_BRIEF_BYTES = 4096;
/** `details.reason` of a run refused because its brief cannot be read or no longer matches (fail closed). */
export const PROJECT_BRIEF_UNAVAILABLE = "PROJECT_BRIEF_UNAVAILABLE";
/** Briefs remembered by hash in one process (Assumption, Delegated: a few distinct versions are live at once). */
const MAX_REMEMBERED = 64;

export interface Brief {
  /** Hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  readonly text: string;
}

export class BriefError extends Error {
  override readonly name = "BriefError";
}

/** True when `p` is `root` or inside it (both absolute and normalised). */
function within(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The canonical form of `p`, or `p` resolved when it does not exist (a context checked later by `projects validate`). */
function canonicalOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Read and check a brief file. `forbidden` are the allowed roots and the project's context paths; the file's canonical
 * path may be inside none of them. Throws {@link BriefError} with a message that never quotes the file's content.
 */
export function readBriefFile(file: string, forbidden: readonly string[]): Brief {
  let real: string;
  try {
    real = realpathSync(file);
  } catch (err) {
    throw new BriefError(`cannot be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  for (const root of forbidden) {
    if (within(real, canonicalOrResolved(root))) {
      throw new BriefError("must be outside every allowed root and every context of the project");
    }
  }
  let bytes: Buffer;
  try {
    const st = lstatSync(real);
    if (!st.isFile()) throw new BriefError("is not a regular file");
    if (st.size > MAX_BRIEF_BYTES) throw new BriefError(`is ${st.size} bytes; the limit is ${MAX_BRIEF_BYTES}`);
    bytes = readFileSync(real);
  } catch (err) {
    if (err instanceof BriefError) throw err;
    throw new BriefError(`cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (bytes.length > MAX_BRIEF_BYTES) throw new BriefError(`is ${bytes.length} bytes; the limit is ${MAX_BRIEF_BYTES}`);
  if (bytes.length === 0) throw new BriefError("is empty; remove brief_file instead");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BriefError("is not valid UTF-8");
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), text };
}

const remembered = new Map<string, string>();

/** Admission: read the brief, remember its text by hash and return it. Throws {@link BriefError}. */
export function freezeBrief(file: string, forbidden: readonly string[]): Brief {
  const brief = readBriefFile(file, forbidden);
  remembered.delete(brief.sha256);
  remembered.set(brief.sha256, brief.text);
  while (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string);
  return brief;
}

/**
 * Dispatch: the brief frozen at admission under `sha256`, from memory, else from `file` when its hash still matches.
 * Undefined when neither has it (the caller fails the run closed).
 */
export function frozenBrief(sha256: string, file: string | undefined, forbidden: readonly string[]): Brief | undefined {
  const text = remembered.get(sha256);
  if (text !== undefined) return { sha256, text };
  if (file === undefined) return undefined;
  try {
    const brief = readBriefFile(file, forbidden);
    return brief.sha256 === sha256 ? brief : undefined;
  } catch {
    return undefined;
  }
}

/** Controller estimate of a text's tokens (Assumption: UTF-8 bytes / 4, rounded up), as for the context pack. */
export function briefTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/** Length of the delimiter nonce (hex digits), as for the context pack. */
export const BRIEF_NONCE_HEX = 16;

/**
 * The labelled block placed before the retrieved context. The brief is operator-trusted, but still delimited: the
 * closing line carries a random nonce, so the text cannot close the block.
 */
export function renderBriefBlock(projectId: string, brief: Brief, nonce: string): string {
  const body = brief.text.endsWith("\n") ? brief.text.slice(0, -1) : brief.text;
  return [
    `<switchboard-project-brief ${nonce}>`,
    `PROJECT BRIEF of project ${JSON.stringify(projectId)}, maintained by the operator in Switchboard's configuration,`,
    "outside the repository: the goal, definition of done and known failures. It is context for the request above,",
    "which takes precedence where they differ.",
    `brief_sha256: ${brief.sha256}`,
    body,
    `</switchboard-project-brief ${nonce}>`,
  ].join("\n");
}

/** Tokens the brief's block and its separator from the pack take from the context budget. */
export function briefBlockTokens(projectId: string, brief: Brief): number {
  return briefTokens(`${renderBriefBlock(projectId, brief, "0".repeat(BRIEF_NONCE_HEX))}\n\n`);
}
