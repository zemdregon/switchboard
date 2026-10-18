/**
 * Test-only (excluded from the build): the model-literal detector of TDD §4.9 item 13 (FR-ADP-05, T4.5), shared by the
 * adapter-source scan in `src/models/models.test.ts` and the scratch adapter's checklist test (T4.2). A heuristic: it
 * can miss a name it does not know.
 */

/** Provider and model-family words that, followed by a version digit or a tier word, read as a model name. */
export const FAMILY =
  "claude|gpt|chatgpt|gemini|gemma|grok|kimi|moonshot|sonnet|opus|haiku|composer|llama|mistral|deepseek|qwen|muse|o[134]";
export const MODEL_LIKE = new RegExp(
  `\\b(?:${FAMILY})[-_. ]?(?:mini|pro|flash|nano|max|ultra|lite|turbo|preview|latest|[0-9])`,
  "i",
);
/** A context-window-sized number or a 128k/1m style size. */
export const LIMIT_LIKE = /\b(?:1_?000_?000|2_?00_?000|128_?000|256_?000|32_?768|65_?536|131_?072|\d{2,4}[kK])\b/;

/** `<line>: <match>` for every line holding a model-like name or a context-window-sized number. */
export function modelLiteralHits(text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    const m = MODEL_LIKE.exec(line) ?? LIMIT_LIKE.exec(line);
    if (m) hits.push(`${i + 1}: ${m[0]}`);
  });
  return hits;
}
