import { describe, expect, it } from "vitest";
import { type EffectiveProjectRag, RAG_DEFAULTS } from "../config/index.js";
import { scanOptionsForContext } from "./options.js";

const on: EffectiveProjectRag = {
  enabled: true,
  caps: { ...RAG_DEFAULTS.caps, maxFiles: 50 },
  exclude: ["dist/**"],
  useGlobal: false,
  contributeToGlobal: false,
};

describe("scanOptionsForContext (T12.2; LLD §14.1)", () => {
  it("is undefined when the project is off or the context says off", () => {
    expect(scanOptionsForContext({ enabled: false, reason: "NO_BACKEND" }, undefined)).toBeUndefined();
    expect(scanOptionsForContext(on, { mode: "off" })).toBeUndefined();
  });

  it("only lowers caps and unions exclusions", () => {
    expect(
      scanOptionsForContext(on, { caps: { max_files: 500, max_file_bytes: 2048 }, exclude: ["vendor/**"] }),
    ).toEqual({
      maxFileBytes: 2048,
      maxFiles: 50,
      maxChunks: RAG_DEFAULTS.caps.maxChunks,
      maxTotalBytes: RAG_DEFAULTS.caps.maxTotalBytes,
      exclude: ["dist/**", "vendor/**"],
    });
  });
});
