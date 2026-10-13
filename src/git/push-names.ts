/**
 * Pure name checks for the push target (T9.6, ADR-0028), shared by the config loader (`src/config/projects.ts`) and the
 * push library (`src/git/push.ts`). No imports, so the config module does not depend on Git or the ledger.
 */

/** A configured remote name: letters, digits, `.`, `_`, `-`; starts with a letter or digit; at most 100. Never a URL. */
export function isRemoteName(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 100 || s.includes("..")) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (i === 0 ? !alnum : !(alnum || c === 46 || c === 95 || c === 45)) return false;
  }
  return true;
}

/**
 * A remote branch-name prefix: letters, digits, `.`, `_`, `-`, `/`; at most 100; no leading `/`, `-` or `.`, no `//`
 * or `..`, no component starting with `.` or ending in `.lock`, not under `refs/`. `git check-ref-format` checks the
 * full target again at push time.
 */
export function isBranchPrefix(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 100) return false;
  if (s.startsWith("/") || s.startsWith("-") || s.startsWith(".") || s.startsWith("refs/")) return false;
  if (s.includes("//") || s.includes("..")) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 45;
    if (!ok && c !== 47) return false;
  }
  const parts = s.split("/");
  const last = parts.length - 1;
  return parts.every((p, i) => (p === "" ? i === last : !p.startsWith(".") && !p.endsWith(".lock")));
}
