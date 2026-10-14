/**
 * Deterministic input budget (T11.2; LLD §13.4 step 3). Never cuts inside a UTF-8 sequence and always inserts the marker
 * line `[truncated: <n> bytes omitted]`. The diff-aware variant (whole hunks in path order) belongs to the commit and PR
 * task contracts (T11.4, T11.8) and is supplied through `InnerTaskContract.truncate`; this is the head-and-tail form the
 * LLD prescribes for logs and long text (25% head, 75% tail; proposed target split).
 */
export const HEAD_SHARE = 0.25;

const isContinuation = (b: number) => (b & 0xc0) === 0x80;

export interface Truncated {
  text: string;
  /** Bytes dropped; 0 when the text fit. */
  omitted: number;
}

export function truncateHeadTail(text: string, budgetBytes: number): Truncated {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budgetBytes) return { text, omitted: 0 };
  // The marker names the omitted count; reserve for its widest possible form (all bytes) plus two newlines.
  const reserve = Buffer.byteLength(`[truncated: ${buf.length} bytes omitted]`) + 2;
  const keep = Math.max(0, budgetBytes - reserve);
  let headEnd = Math.floor(keep * HEAD_SHARE);
  while (headEnd > 0 && isContinuation(buf[headEnd] ?? 0)) headEnd--;
  let tailStart = buf.length - (keep - Math.floor(keep * HEAD_SHARE));
  while (tailStart < buf.length && isContinuation(buf[tailStart] ?? 0)) tailStart++;
  const omitted = tailStart - headEnd;
  const out = `${buf.subarray(0, headEnd).toString("utf8")}\n[truncated: ${omitted} bytes omitted]\n${buf.subarray(tailStart).toString("utf8")}`;
  return { text: out, omitted };
}
