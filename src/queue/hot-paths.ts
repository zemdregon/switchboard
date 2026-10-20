/**
 * Work-item `hot_paths` (T15.7; FR-QUE-07, LLD §20.4). Up to {@link MAX_HOT_PATHS} relative path globs per item. Two
 * items overlap when the literal prefix (the text before the first glob metacharacter) of any glob of one is a string
 * prefix of a literal prefix of the other. The rule is conservative on purpose: `src/a` overlaps `src/ab/x`, and a glob
 * that starts with a metacharacter (empty literal prefix) overlaps everything. No imports: the ledger uses it too.
 */

export const MAX_HOT_PATHS = 32;
export const MAX_HOT_PATH_LENGTH = 512;

const META = /[*?[\]{}!\\]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class refuses control characters on purpose
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** Why a `hot_paths` value is refused, or undefined when it is valid. */
export function hotPathsProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "hot_paths must be an array";
  if (value.length > MAX_HOT_PATHS) return `hot_paths holds at most ${MAX_HOT_PATHS} globs`;
  for (const g of value) {
    if (typeof g !== "string" || g.length === 0 || g.length > MAX_HOT_PATH_LENGTH) {
      return `each hot_paths glob is a string of 1 to ${MAX_HOT_PATH_LENGTH} characters`;
    }
    if (CONTROL.test(g)) return "a hot_paths glob must not contain control characters";
    if (g.startsWith("/")) return "a hot_paths glob is relative to the repository root";
    if (g.split("/").includes("..")) return "a hot_paths glob must not contain a .. segment";
  }
  return undefined;
}

/** The text of a glob before its first metacharacter. */
export function literalPrefix(glob: string): string {
  const m = META.exec(glob);
  return m === null ? glob : glob.slice(0, m.index);
}

/** True when any glob of `a` overlaps any glob of `b` (LLD §20.4, conservative literal-prefix rule). */
export function hotPathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const pa = a.map(literalPrefix);
  const pb = b.map(literalPrefix);
  return pa.some((x) => pb.some((y) => x.startsWith(y) || y.startsWith(x)));
}

/** Parses a stored `hot_paths_json` value; an unreadable value reads as overlapping everything (fail closed). */
export function storedHotPaths(json: string | null): readonly string[] {
  if (json === null) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (hotPathsProblem(v) === undefined) return v as string[];
  } catch {
    // fall through
  }
  return [""];
}
