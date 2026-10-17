/**
 * Line diff of two stored versions' canonical text (T16.2; FR-SKL-09, LLD §19.10 `skills diff`). Pure and read-only.
 *
 * Delegated: the common prefix and suffix are trimmed, then the middle is a longest-common-subsequence diff when it has
 * at most {@link MAX_LCS_CELLS} cells. A larger middle is shown as all removed then all added: still a correct diff,
 * only not minimal, so a 1 MiB body cannot make the CLI allocate an unbounded table.
 */

export type DiffOp = { readonly kind: " " | "-" | "+"; readonly line: string };

export const MAX_LCS_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

/** Split canonical text (LF line ends, one final LF) into lines without the final empty one. */
export function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = a.slice(0, start).map((line) => ({ kind: " ", line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    for (const line of midA) ops.push({ kind: "-", line });
    for (const line of midB) ops.push({ kind: "+", line });
  } else {
    // lcs[i * (m + 1) + j]: LCS length of midA[i..] and midB[j..].
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: " ", line: midA[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
        ops.push({ kind: "-", line: midA[i] as string });
        i++;
      } else {
        ops.push({ kind: "+", line: midB[j] as string });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ kind: "-", line: midA[i] as string });
    for (; j < m; j++) ops.push({ kind: "+", line: midB[j] as string });
  }
  for (const line of a.slice(endA)) ops.push({ kind: " ", line });
  return ops;
}

/** Unified diff (three context lines) of two canonical texts; empty when they are equal. */
export function unifiedDiff(aText: string, bText: string, aLabel: string, bLabel: string): string {
  const ops = diffLines(textLines(aText), textLines(bText));
  const changed = ops.map((o, idx) => (o.kind === " " ? -1 : idx)).filter((idx) => idx >= 0);
  if (changed.length === 0) return "";
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  // Line numbers (1-based) before each op, on each side.
  const posA: number[] = [];
  const posB: number[] = [];
  let la = 1;
  let lb = 1;
  for (const o of ops) {
    posA.push(la);
    posB.push(lb);
    if (o.kind !== "+") la++;
    if (o.kind !== "-") lb++;
  }
  let k = 0;
  while (k < changed.length) {
    const from = Math.max(0, (changed[k] as number) - CONTEXT_LINES);
    let to = Math.min(ops.length, (changed[k] as number) + CONTEXT_LINES + 1);
    k++;
    while (k < changed.length && (changed[k] as number) - CONTEXT_LINES <= to) {
      to = Math.min(ops.length, (changed[k] as number) + CONTEXT_LINES + 1);
      k++;
    }
    const hunk = ops.slice(from, to);
    const countA = hunk.filter((o) => o.kind !== "+").length;
    const countB = hunk.filter((o) => o.kind !== "-").length;
    const startA = countA === 0 ? (posA[from] as number) - 1 : (posA[from] as number);
    const startB = countB === 0 ? (posB[from] as number) - 1 : (posB[from] as number);
    out.push(`@@ -${startA},${countA} +${startB},${countB} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.line}`);
  }
  return `${out.join("\n")}\n`;
}
