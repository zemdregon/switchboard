/** Line-framed JSONL reader for provider stdout (LLD §8 "Line framing"). */

/** Proposed target from LLD §8: 1 MiB. */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

export type JsonlProtocolErrorKind = "line_too_long" | "invalid_utf8" | "invalid_json";

export interface JsonlProtocolError {
  readonly kind: JsonlProtocolErrorKind;
  readonly lineNumber: number;
  readonly message: string;
}

export interface JsonlReaderOptions {
  /** Maximum bytes in one line, excluding the newline. Default 1 MiB (Proposed). */
  readonly maxLineBytes?: number;
  /** Lines for which this returns true are skipped (adapter-declared ignorable line types). */
  readonly isIgnorable?: (line: string) => boolean;
  /** Treat a blank line as `invalid_json` instead of skipping it (ACP: no line is ignorable, ADR-0036 item 3). */
  readonly rejectBlankLines?: boolean;
  readonly onEvent: (value: unknown, lineNumber: number) => void;
  /** Called at most once; the reader then stops consuming input. */
  readonly onProtocolError: (error: JsonlProtocolError) => void;
}

const NEWLINE = 0x0a;

/**
 * Splits a byte stream on `\n` (tolerating `\r\n`), decodes each line as strict UTF-8 and parses it as JSON.
 * Works on bytes so multi-byte characters split across chunks are handled. After the first protocol error the
 * reader is `failed` and ignores further input; it never throws.
 */
export class JsonlReader {
  readonly #maxLineBytes: number;
  readonly #opts: JsonlReaderOptions;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #lineNumber = 0;
  #failed = false;

  constructor(opts: JsonlReaderOptions) {
    this.#opts = opts;
    this.#maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  get failed(): boolean {
    return this.#failed;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (!this.#failed && start < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start);
      if (nl === -1) {
        this.#append(chunk.subarray(start));
        return;
      }
      this.#append(chunk.subarray(start, nl));
      if (this.#failed) return;
      this.#flushLine();
      start = nl + 1;
    }
  }

  /** Flush a final unterminated line at end of stream. */
  end(): void {
    if (!this.#failed && this.#pendingBytes > 0) this.#flushLine();
  }

  #append(part: Buffer): void {
    if (part.length === 0) return;
    this.#pendingBytes += part.length;
    // Fail as soon as the cap is exceeded rather than buffering an unbounded line.
    if (this.#pendingBytes > this.#maxLineBytes + 1) {
      this.#fail("line_too_long", `line ${this.#lineNumber + 1} exceeds ${this.#maxLineBytes} bytes`);
      return;
    }
    this.#pending.push(part);
  }

  #flushLine(): void {
    this.#lineNumber += 1;
    let bytes = Buffer.concat(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, -1);
    if (bytes.length > this.#maxLineBytes) {
      this.#fail("line_too_long", `line ${this.#lineNumber} exceeds ${this.#maxLineBytes} bytes`);
      return;
    }
    let text: string;
    try {
      text = this.#decoder.decode(bytes);
    } catch {
      this.#fail("invalid_utf8", `line ${this.#lineNumber} is not valid UTF-8`);
      return;
    }
    if (text.trim() === "" && this.#opts.rejectBlankLines === true) {
      this.#fail("invalid_json", `line ${this.#lineNumber} is blank`);
      return;
    }
    if (text.trim() === "" || this.#opts.isIgnorable?.(text)) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.#fail("invalid_json", `line ${this.#lineNumber} is not valid JSON`);
      return;
    }
    this.#opts.onEvent(value, this.#lineNumber);
  }

  #fail(kind: JsonlProtocolErrorKind, message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#opts.onProtocolError({ kind, lineNumber: this.#lineNumber + (kind === "line_too_long" ? 1 : 0), message });
  }
}
