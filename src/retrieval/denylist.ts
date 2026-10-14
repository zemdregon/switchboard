/**
 * Retrieval-index name filters (T12.2; FR-RAG-02, LLD §14.3, ADR-0031, ADR-0022).
 *
 * The built-in secret denylist is matched on the file NAME, before the file is opened, so a denylisted file's content is
 * never read. It is a best-effort net, not a guarantee (R-56): a secret in an oddly named file, or inside an ordinary
 * source file, is not caught here; the second layer is the content redactor applied before chunking (`scan.ts`).
 * Operator `exclude` globs are matched against the root-relative POSIX path with a small matcher (no dependency).
 */

const EXACT_NAMES: ReadonlySet<string> = new Set([
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
]);
const SUFFIXES: readonly string[] = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const PREFIXES: readonly string[] = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
const SUBSTRINGS: readonly string[] = ["credential", "secret", "token", "password", "auth"];

/** True when the final path component matches the built-in secret denylist (case-insensitive). */
export function isDenylisted(relPath: string): boolean {
  const name = (relPath.split("/").pop() ?? "").toLowerCase();
  if (name === "") return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (EXACT_NAMES.has(name)) return true;
  if (SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (PREFIXES.some((p) => name.startsWith(p))) return true;
  return SUBSTRINGS.some((s) => name.includes(s));
}

/**
 * Translate a simple glob to an anchored regular expression: `**` any characters including `/`, `**` followed by `/`
 * zero or more directories, `*` any characters except `/`, `?` one character except `/`. Everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\/+/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "su");
}

/**
 * Compile operator globs into a predicate on a root-relative POSIX path. Delegated: a glob that matches a directory path
 * also excludes everything below it (so `vendor` and `vendor/**` behave alike).
 */
export function compileExcludes(globs: readonly string[]): (relPath: string) => boolean {
  const res = globs.filter((g) => g.trim() !== "").map(globToRegExp);
  return (relPath) => {
    if (res.length === 0) return false;
    const parts = relPath.split("/");
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join("/");
      if (res.some((re) => re.test(prefix))) return true;
    }
    return false;
  };
}
