/**
 * Operator sanitiser patterns: validation that keeps a backtracking regular-expression engine safe (FR-GIT-04, LLD
 * §12.4, T9.3; ADR-0025). Leaf module: it imports nothing, so the configuration loader can use it.
 *
 * Why not RE2. Node has no RE2 and no way to time-box a synchronous `RegExp` call. A native RE2 binding would be a new
 * dependency and a change to the technology stack (AGENTS.md: ADR; TDD §2), so it is not adopted here. Instead the
 * accepted language is a small subset in which a match costs at most polynomial time with a small exponent, and the
 * input is length-capped before matching (see `sanitize.ts`). The subset is checked by a parser, not by guessing at the
 * compiled `RegExp`.
 *
 * Accepted: literals, `.`, escapes `\d \D \w \W \s \S \b \B`, escaped punctuation and `\t \n \r \f \v`, `\uXXXX`,
 * `\xXX`, character classes `[...]` (no nested quantifier meaning), anchors `^` `$`, groups `( )` and `(?: )`, alternation
 * `|`, and the quantifiers `* + ? {n} {n,m} {n,}` with an optional lazy `?`.
 *
 * Rejected: back-references (`\1`, `\k<name>`), look-ahead and look-behind, named groups, Unicode property escapes,
 * any other `(?` form, a quantifier on a group that itself contains a quantifier or an alternation (the shapes behind
 * exponential `(a+)+` and `(a|a)*` blow-ups), a quantifier with nothing to repeat, `{n,m}` above {@link MAX_REPEAT},
 * more than {@link MAX_UNBOUNDED} unbounded quantifiers in one pattern (each extra one multiplies the worst case by the
 * input length: `.*.*.*x` is cubic), a pattern longer than {@link MAX_PATTERN_LENGTH}, and a list longer than
 * {@link MAX_PATTERNS}. Patterns compile with the `iu` flags (case-insensitive, strict escapes).
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_PATTERNS = 16;
/** Largest `n` or `m` in `{n}`, `{n,m}` or `{n,}`. */
export const MAX_REPEAT = 64;
/**
 * Unbounded quantifiers (`*`, `+`, `{n,}`) allowed in one pattern. Matching is unanchored, so a pattern with k unbounded
 * quantifiers costs O(L^(k+1)) steps on a line of L characters (measured: `.*a.*b` took 36 s on 4096 characters, which
 * is why the limit is 1 and not 2).
 */
export const MAX_UNBOUNDED = 1;
/** Operator patterns are matched against windows of this many characters (`sanitize.ts`). */
export const PATTERN_WINDOW = 1024;
/**
 * Upper bound on the estimated step count `PATTERN_WINDOW^(unbounded+1) x choices`, where `choices` multiplies the number
 * of alternatives of each bounded quantifier (`?` is 2, `{n,m}` is m-n+1, `{n}` is 1). 2^26 is about 67 million steps.
 */
export const MAX_COST = 2 ** 26;

export class PatternError extends Error {
  override readonly name = "PatternError";
}

const SIMPLE_ESCAPES = new Set(["d", "D", "w", "W", "s", "S", "b", "B", "t", "n", "r", "f", "v", "0"]);
const SYNTAX_CHARS = new Set(["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"]);

interface Frame {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

/** Throws {@link PatternError} unless `source` is in the accepted subset. Returns the compiled expression. */
export function compileOperatorPattern(source: string): RegExp {
  if (typeof source !== "string" || source.length === 0) throw new PatternError("pattern must be a non-empty string");
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  if (source.includes("\n") || source.includes("\r")) {
    throw new PatternError("pattern must not contain a line break (matching is line by line)");
  }
  checkSubset(source);
  try {
    return new RegExp(source, "iu");
  } catch (err) {
    throw new PatternError(`pattern does not compile: ${(err as Error).message}`);
  }
}

function checkSubset(src: string): void {
  const stack: Frame[] = [{ hasQuantifier: false, hasAlternation: false }];
  let unbounded = 0;
  let choices = 1;
  // `lastAtom` is what a following quantifier would repeat: undefined (nothing), "atom", or a closed group's frame.
  let lastAtom: "atom" | Frame | undefined;
  let i = 0;
  const top = () => stack[stack.length - 1] as Frame;

  const quantify = (bounded: boolean, optional: boolean, alternatives = 1) => {
    if (lastAtom === undefined) throw new PatternError(`quantifier at ${i} has nothing to repeat`);
    // `(a|b)?` repeats at most once, so an alternation alone is harmless there; anything else inside is not.
    if (typeof lastAtom === "object" && (lastAtom.hasQuantifier || (lastAtom.hasAlternation && !optional))) {
      throw new PatternError(`quantified group at ${i} contains a quantifier or an alternation (backtracking risk)`);
    }
    if (!bounded && ++unbounded > MAX_UNBOUNDED) {
      throw new PatternError(`more than ${MAX_UNBOUNDED} unbounded quantifiers (*, +, {n,})`);
    }
    if (bounded) choices *= alternatives;
    top().hasQuantifier = true;
    lastAtom = undefined; // a second quantifier directly after one is not allowed (a lazy `?` is consumed below)
  };

  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) throw new PatternError("pattern ends with a backslash");
      if (/[1-9]/.test(n) || n === "k") throw new PatternError("back-references are not allowed");
      if (n === "p" || n === "P") throw new PatternError("Unicode property escapes are not allowed");
      if (n === "u" || n === "x") {
        const len = n === "u" ? 4 : 2;
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(src.slice(i + 2, i + 2 + len))) {
          throw new PatternError(`malformed \\${n} escape`);
        }
        i += 2 + len;
      } else if (SIMPLE_ESCAPES.has(n) || SYNTAX_CHARS.has(n)) {
        i += 2;
      } else {
        throw new PatternError(`escape \\${n} is not allowed`);
      }
      lastAtom = "atom";
      continue;
    }
    if (c === "[") {
      i = skipClass(src, i);
      lastAtom = "atom";
      continue;
    }
    if (c === "(") {
      if (src[i + 1] === "?") {
        if (src[i + 2] !== ":")
          throw new PatternError("only (?: ) groups are allowed (no look-around or named groups)");
        i += 3;
      } else {
        i += 1;
      }
      stack.push({ hasQuantifier: false, hasAlternation: false });
      lastAtom = undefined;
      continue;
    }
    if (c === ")") {
      if (stack.length === 1) throw new PatternError("unbalanced )");
      const closed = stack.pop() as Frame;
      // A closed group makes its parent "contain" whatever it contained.
      if (closed.hasQuantifier) top().hasQuantifier = true;
      if (closed.hasAlternation) top().hasAlternation = true;
      lastAtom = closed;
      i += 1;
      continue;
    }
    if (c === "|") {
      top().hasAlternation = true;
      lastAtom = undefined;
      i += 1;
      continue;
    }
    if (c === "*" || c === "+" || c === "?") {
      quantify(c === "?", c === "?", c === "?" ? 2 : 1);
      i += 1;
      if (src[i] === "?") i += 1; // lazy modifier
      continue;
    }
    if (c === "{") {
      const m = /^\{(\d{1,6})(?:(,)(\d{0,6}))?\}/.exec(src.slice(i));
      if (!m) throw new PatternError(`malformed {n,m} quantifier at ${i}`);
      const lo = Number(m[1]);
      const hasComma = m[2] !== undefined;
      const hi = m[3] === undefined || m[3] === "" ? undefined : Number(m[3]);
      if (lo > MAX_REPEAT || (hi !== undefined && hi > MAX_REPEAT)) {
        throw new PatternError(`repeat count above ${MAX_REPEAT}`);
      }
      if (hi !== undefined && hi < lo) throw new PatternError("{n,m} with m < n");
      quantify(!hasComma || hi !== undefined, false, !hasComma ? 1 : hi === undefined ? 1 : hi - lo + 1);
      i += m[0].length;
      if (src[i] === "?") i += 1;
      continue;
    }
    if (c === "}" || c === "]") throw new PatternError(`unescaped ${c} at ${i}`);
    // `^`, `$`, `.` and literals are atoms (`^`/`$` repeated are harmless but pointless; allow).
    lastAtom = "atom";
    i += 1;
  }
  if (stack.length !== 1) throw new PatternError("unbalanced (");
  const cost = PATTERN_WINDOW ** (unbounded + 1) * choices;
  if (cost > MAX_COST)
    throw new PatternError(`pattern is too expensive to match (estimated ${cost} steps, limit ${MAX_COST})`);
}

/** Index just past the `]` that closes the class opening at `start`. Classes hold no quantifier meaning. */
function skipClass(src: string, start: number): number {
  let i = start + 1;
  if (src[i] === "^") i += 1;
  if (src[i] === "]") throw new PatternError("empty character class");
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) break;
      if (/[1-9]/.test(n) || n === "k" || n === "p" || n === "P") {
        throw new PatternError("back-references and property escapes are not allowed");
      }
      i += n === "u" ? 6 : n === "x" ? 4 : 2;
      continue;
    }
    if (c === "[") throw new PatternError("unescaped [ inside a character class");
    if (c === "]") return i + 1;
    i += 1;
  }
  throw new PatternError("unterminated character class");
}

/** Validate a whole `git.sanitize_patterns` list; every problem is reported with its index. */
export function validateOperatorPatterns(patterns: readonly string[]): string[] {
  const errors: string[] = [];
  if (patterns.length > MAX_PATTERNS)
    errors.push(`at most ${MAX_PATTERNS} patterns are allowed (got ${patterns.length})`);
  patterns.forEach((p, i) => {
    try {
      compileOperatorPattern(p);
    } catch (err) {
      errors.push(`[${i}]: ${(err as Error).message}`);
    }
  });
  return errors;
}
