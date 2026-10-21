/**
 * Closed refusal vocabulary of the submodule library (ADR-0087 items 2 and 3). Every message is fixed per reason: no
 * URL text, no `.gitmodules` value other than the offending umbrella-relative path (kept in {@link SubmoduleError.path},
 * never in the message) and nothing Git printed is ever repeated, because any of them could carry a credential.
 */

export type SubmoduleReason =
  /** A used `.gitmodules` URL is not `https://<host>/<owner>/<repo>[.git]` (ADR-0068) nor `../<repo>[.git]`. */
  | "SUBMODULE_URL_INVALID"
  /** The URL's host or owner is not in the effective `project_sources`. */
  | "SUBMODULE_SOURCE_NOT_ALLOWED"
  /** A gitlink that is not excluded has no (or more than one) `.gitmodules` entry with its path. */
  | "SUBMODULE_UNDECLARED"
  /** A gitlink or declared path is absolute, has an empty, `.`, `..` or `.git` segment, a control character or `\`. */
  | "SUBMODULE_PATH_UNSAFE"
  /** More than {@link MAX_SUBMODULES} gitlinks or `.gitmodules` sections. */
  | "SUBMODULE_MANIFEST_TOO_LARGE"
  /** Git could not read the umbrella commit, its tree or its `.gitmodules` blob. */
  | "SUBMODULE_MANIFEST_UNREADABLE"
  /** A gitlink commit is not in its store (attach refuses rather than fetching). */
  | "SUBMODULE_COMMIT_MISSING"
  /** `git worktree add` of a submodule path failed for another reason. */
  | "SUBMODULE_ATTACH_FAILED"
  /** A submodule worktree's `.git` link does not match its store's worktree record (fail closed). */
  | "SUBMODULE_LINK_INVALID"
  /** An attach record on disk is not one this library wrote (shape, path or store outside `clone_root`). */
  | "SUBMODULE_RECORD_INVALID";

/** **Delegated** (ADR-0087 item 2): the most submodules one umbrella commit may declare. */
export const MAX_SUBMODULES = 1024;

const FIXED_TEXT: Readonly<Record<SubmoduleReason, string>> = {
  SUBMODULE_URL_INVALID:
    "a submodule URL must be https://<host>/<owner>/<repo> (optional .git) or ../<repo> (optional .git), without credentials, port, query or fragment",
  SUBMODULE_SOURCE_NOT_ALLOWED: "a submodule repository host or owner is not in this server's project_sources",
  SUBMODULE_UNDECLARED: "a submodule gitlink has no single .gitmodules entry with its path",
  SUBMODULE_PATH_UNSAFE: "a submodule path is not a safe worktree-relative path",
  SUBMODULE_MANIFEST_TOO_LARGE: `the umbrella declares more than ${MAX_SUBMODULES} submodules`,
  SUBMODULE_MANIFEST_UNREADABLE: "the umbrella commit's submodule manifest could not be read",
  SUBMODULE_COMMIT_MISSING: "a submodule commit is not present in its repository store",
  SUBMODULE_ATTACH_FAILED: "a submodule worktree could not be created",
  SUBMODULE_LINK_INVALID: "a submodule worktree's .git link does not match its repository store",
  SUBMODULE_RECORD_INVALID: "the submodule attach record is not valid",
};

/** A refused or failed submodule operation. The message is fixed per reason. */
export class SubmoduleError extends Error {
  override readonly name = "SubmoduleError";
  /** The umbrella-relative path the refusal is about, when there is one (untrusted text: escape before display). */
  readonly path?: string;
  constructor(
    readonly reason: SubmoduleReason,
    opts: { readonly path?: string } = {},
  ) {
    super(FIXED_TEXT[reason]);
    if (opts.path !== undefined) this.path = opts.path;
  }
  /** The taxonomy code, as {@link import("../projects/clone.js").CloneError} maps its reasons. */
  get code(): "INVALID_REQUEST" | "PERMISSION_BLOCKED" | "TOOL_FAILURE" {
    switch (this.reason) {
      case "SUBMODULE_URL_INVALID":
      case "SUBMODULE_UNDECLARED":
      case "SUBMODULE_PATH_UNSAFE":
      case "SUBMODULE_MANIFEST_TOO_LARGE":
        return "INVALID_REQUEST";
      case "SUBMODULE_SOURCE_NOT_ALLOWED":
      case "SUBMODULE_LINK_INVALID":
        return "PERMISSION_BLOCKED";
      default:
        return "TOOL_FAILURE";
    }
  }
}

/**
 * Whether `p` is a safe worktree-relative POSIX path (ADR-0087 items 1 and 2): non-empty, no leading `/`, no empty,
 * `.` or `..` segment, no `.git` segment (case-insensitive, as a case-insensitive file system would treat it), no
 * control character and no backslash.
 */
export function isSafeSubmodulePath(p: string): boolean {
  if (p === "" || p.length > 4096 || p.startsWith("/") || p.includes("\\")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
  if (/[\u0000-\u001f\u007f]/u.test(p)) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === ".." || seg.toLowerCase() === ".git") return false;
  }
  return true;
}

/** Full object id (SHA-1 or SHA-256), lower-case hex. */
export function isFullSha(s: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(s);
}
