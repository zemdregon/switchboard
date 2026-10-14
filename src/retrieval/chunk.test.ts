import { describe, expect, it } from "vitest";
import { chunkId, chunkText, MAX_CHUNK_BYTES, WINDOW_LINES } from "./chunk.js";

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");

describe("chunkText", () => {
  it("splits into 40-line windows with 1-based inclusive line numbers and no overlap", () => {
    const cs = chunkText("a.txt", `${lines(100)}\n`);
    expect(cs.map((c) => [c.ordinal, c.startLine, c.endLine])).toEqual([
      [0, 1, WINDOW_LINES],
      [1, 41, 80],
      [2, 81, 100],
    ]);
    expect(cs[1]?.text.startsWith("line 41\n")).toBe(true);
  });

  it("bounds each chunk to 4096 bytes", () => {
    const cs = chunkText(
      "a.txt",
      lines(30, () => "x".repeat(1000)),
    );
    expect(cs.length).toBeGreaterThan(1);
    for (const c of cs) expect(Buffer.byteLength(c.text, "utf8")).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(cs.map((c) => c.text.split("\n").length).reduce((a, b) => a + b, 0)).toBe(30);
  });

  it("splits a long single line at UTF-8 safe boundaries", () => {
    const line = "é€😀".repeat(2000); // 2, 3 and 4 byte characters
    const cs = chunkText("a.txt", `before\n${line}\nafter`);
    const mid = cs.filter((c) => c.startLine === 2);
    expect(mid.length).toBeGreaterThan(1);
    for (const c of mid) {
      expect(c.endLine).toBe(2);
      expect(Buffer.byteLength(c.text, "utf8")).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(c.text).not.toContain("�");
    }
    expect(mid.map((c) => c.text).join("")).toBe(line);
    expect(cs[0]?.text).toBe("before");
    expect(cs[cs.length - 1]?.text).toBe("after");
    expect(cs[cs.length - 1]?.startLine).toBe(3);
  });

  it("drops empty and whitespace-only windows and numbers kept chunks consecutively", () => {
    expect(chunkText("a.txt", "")).toEqual([]);
    expect(chunkText("a.txt", "\n\n  \n\t\n")).toEqual([]);
    const cs = chunkText("a.txt", `${"\n".repeat(WINDOW_LINES)}tail`);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ ordinal: 0, startLine: WINDOW_LINES + 1, endLine: WINDOW_LINES + 1, text: "tail" });
  });

  it("is deterministic and ids depend on path, ordinal and text", () => {
    const text = lines(90);
    const a = chunkText("a.txt", text);
    expect(chunkText("a.txt", text)).toEqual(a);
    for (const c of a) {
      expect(c.id).toMatch(/^chk_[0-9a-f]{24}$/);
      expect(c.id).toBe(chunkId(c.path, c.ordinal, c.textSha256));
    }
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    expect(chunkText("b.txt", text)[0]?.id).not.toBe(a[0]?.id);
    // a change in a later window leaves earlier ids untouched (no overlap)
    const changed = chunkText("a.txt", `${text}\nextra`);
    expect(changed[0]?.id).toBe(a[0]?.id);
    expect(changed[1]?.id).toBe(a[1]?.id);
  });
});
