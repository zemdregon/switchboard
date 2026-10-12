import { describe, expect, it } from "vitest";
import { type JsonlProtocolError, JsonlReader } from "./jsonl.js";

function collect(maxLineBytes?: number) {
  const events: unknown[] = [];
  const errors: JsonlProtocolError[] = [];
  const reader = new JsonlReader({
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
    onEvent: (v) => events.push(v),
    onProtocolError: (e) => errors.push(e),
  });
  return { reader, events, errors };
}

describe("JsonlReader", () => {
  it("handles lines split across arbitrary chunks, including multi-byte characters", () => {
    const { reader, events, errors } = collect();
    const bytes = Buffer.from('{"a":"héllo ✓"}\n{"b":2}\r\n{"c":3}', "utf8");
    for (const b of bytes) reader.push(Buffer.from([b]));
    reader.end();
    expect(errors).toEqual([]);
    expect(events).toEqual([{ a: "héllo ✓" }, { b: 2 }, { c: 3 }]);
  });

  it("handles several lines in one chunk and skips blank lines", () => {
    const { reader, events } = collect();
    reader.push(Buffer.from('{"a":1}\n\n{"a":2}\n'));
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("reports an oversize line once, without buffering it, and stops", () => {
    const { reader, events, errors } = collect(16);
    reader.push(Buffer.from('{"a":1}\n'));
    reader.push(Buffer.alloc(100, 0x61));
    reader.push(Buffer.from('\n{"a":2}\n'));
    expect(events).toEqual([{ a: 1 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("line_too_long");
    expect(reader.failed).toBe(true);
  });

  it("accepts a line of exactly the maximum size", () => {
    const { reader, events, errors } = collect(9);
    reader.push(Buffer.from('{"a":"bc"}\n'.replace('"bc"', '"b"')));
    expect(errors).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("reports malformed JSON and invalid UTF-8", () => {
    const a = collect();
    a.reader.push(Buffer.from("{nope}\n"));
    expect(a.errors[0]?.kind).toBe("invalid_json");
    expect(a.errors[0]?.lineNumber).toBe(1);

    const b = collect();
    b.reader.push(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    expect(b.errors[0]?.kind).toBe("invalid_utf8");
  });

  it("skips lines the adapter declares ignorable", () => {
    const events: unknown[] = [];
    const errors: JsonlProtocolError[] = [];
    const reader = new JsonlReader({
      isIgnorable: (l) => l.startsWith("#"),
      onEvent: (v) => events.push(v),
      onProtocolError: (e) => errors.push(e),
    });
    reader.push(Buffer.from('# banner\n{"a":1}\n'));
    expect(errors).toEqual([]);
    expect(events).toEqual([{ a: 1 }]);
  });
});
