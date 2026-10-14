import { createHash } from "node:crypto";

/**
 * Retrieval-index chunker (T12.2; FR-RAG-02, LLD §14.3, TDD §3.13.4, ADR-0031).
 *
 * Splits on line boundaries into windows of at most {@link WINDOW_LINES} lines, each also bounded to {@link MAX_CHUNK_BYTES}
 * bytes of UTF-8. A single line longer than the bound is split at a code point boundary, never inside a multi-byte
 * character. Overlap is 0 lines (Delegated: no overlap keeps chunk ids stable when a neighbouring window changes).
 * Empty and whitespace-only windows are dropped; ordinals count only kept chunks. Chunk text joins lines with `\n`
 * (no trailing newline). Input must already be redacted (`scan.ts`); this module never sees a raw file.
 */

export const WINDOW_LINES = 40;
export const MAX_CHUNK_BYTES = 4096;

export interface Chunk {
  /** `chk_` plus 24 hex characters of sha256(path NUL ordinal NUL textSha256). */
  readonly id: string;
  /** Root-relative POSIX path. */
  readonly path: string;
  readonly ordinal: number;
  /** 1-based inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly textSha256: string;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function chunkId(path: string, ordinal: number, textSha256: string): string {
  return `chk_${sha256(`${path}\0${ordinal}\0${textSha256}`).slice(0, 24)}`;
}

/** Split `line` into pieces of at most `max` bytes, each ending on a code point boundary. */
function splitLongLine(line: string, max: number): string[] {
  const buf = Buffer.from(line, "utf8");
  const out: string[] = [];
  let start = 0;
  while (start < buf.length) {
    let end = Math.min(start + max, buf.length);
    if (end < buf.length) while (end > start && ((buf[end] as number) & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + max, buf.length); // unreachable for valid UTF-8 and max >= 4
    out.push(buf.subarray(start, end).toString("utf8"));
    start = end;
  }
  return out;
}

export function chunkText(path: string, text: string): Chunk[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  let curStart = 1;

  const emit = (body: string, startLine: number, endLine: number) => {
    if (body.trim() === "") return;
    const ordinal = chunks.length;
    const textSha256 = sha256(body);
    chunks.push({ id: chunkId(path, ordinal, textSha256), path, ordinal, startLine, endLine, text: body, textSha256 });
  };
  const flush = (endLine: number) => {
    if (cur.length > 0) emit(cur.join("\n"), curStart, endLine);
    cur = [];
    curBytes = 0;
  };

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_CHUNK_BYTES) {
      flush(lineNo - 1);
      for (const piece of splitLongLine(line, MAX_CHUNK_BYTES)) emit(piece, lineNo, lineNo);
      curStart = lineNo + 1;
      return;
    }
    if (cur.length > 0 && (cur.length >= WINDOW_LINES || curBytes + 1 + bytes > MAX_CHUNK_BYTES)) {
      flush(lineNo - 1);
      curStart = lineNo;
    }
    if (cur.length === 0) curStart = lineNo;
    curBytes += cur.length === 0 ? bytes : 1 + bytes;
    cur.push(line);
  });
  flush(lines.length);
  return chunks;
}
