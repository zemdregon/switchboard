/**
 * Minimal semver handling for manifest ranges (Proposed; no semver dependency). Supported range grammar: one or more
 * space-separated comparators (`>=`, `>`, `<=`, `<`, `=` or bare version), all of which must hold. Prerelease
 * versions never match (fail closed, ADR-0009). Anything unparseable never matches.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
  build?: string;
}

const VERSION = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?/;

/** Git commit hash: 7-64 hex digits, optionally prefixed with 'g' (git describe). */
const COMMIT_HASH = /^g?[0-9a-fA-F]{7,64}$/;

/** Extracts the first `x.y.z` token from `--version` output such as "2.1.296 (Claude Code)"; null if absent. */
export function parseVersion(output: string | null | undefined): SemVer | null {
  const m = VERSION.exec(output ?? "");
  if (!m) return null;
  const [, a, b, c, pre, build] = m;
  const nums = [Number(a), Number(b), Number(c)];
  if (!nums.every(Number.isSafeInteger)) return null;
  const isCommit = pre !== undefined && COMMIT_HASH.test(pre);
  const prerelease = pre !== undefined && !isCommit;
  const buildMeta = build ?? (isCommit ? pre : undefined);
  return {
    major: nums[0] as number,
    minor: nums[1] as number,
    patch: nums[2] as number,
    prerelease,
    ...(buildMeta !== undefined ? { build: buildMeta } : {}),
  };
}

function compare(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True only when `range` parses completely and `version` satisfies every comparator. */
export function satisfies(version: SemVer, range: string): boolean {
  if (version.prerelease) return false;
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return false;
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(part);
    if (!m) return false;
    const bound = parseVersion(m[2]);
    if (!bound || bound.prerelease) return false;
    const c = compare(version, bound);
    const ok = { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
    if (!ok) return false;
  }
  return true;
}
