/**
 * Project brief at config load and admission (T5.14; FR-SES-07, LLD §20.13). `projects[].brief_file` is refused at
 * load when it is over 4 KiB, missing, empty, not UTF-8, inside an allowed root or a context, or when its block alone
 * exceeds the context budget; a dynamic project cannot carry it; admission freezes its hash and refuses the run when the
 * file cannot be read (Linus decisions (a) and (b), WORK QUEUE v10).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, projectSchema } from "../config/index.js";
import { ToolError } from "../mcp/errors.js";
import { admitBrief } from "../mcp/project-tools.js";
import {
  BriefError,
  briefBlockTokens,
  freezeBrief,
  frozenBrief,
  MAX_BRIEF_BYTES,
  PROJECT_BRIEF_UNAVAILABLE,
  readBriefFile,
  renderBriefBlock,
} from "./brief.js";

let tmp: string;
let roots: string;
let outside: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-brief-")));
  roots = path.join(tmp, "roots");
  outside = path.join(tmp, "operator");
  mkdirSync(path.join(roots, "repo"), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const BRIEF = "Goal: ship the parser.\nDone when: npm test passes.\nKnown failures: flaky lexer test.\n";

const load = (briefFile: string | undefined, extra: Record<string, unknown> = {}) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [roots],
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      projects: [
        {
          id: "web",
          name: "Web",
          contexts: [{ id: "main", kind: "repository", path: path.join(roots, "repo"), base_ref: "main" }],
          ...(briefFile !== undefined ? { brief_file: briefFile } : {}),
        },
      ],
      ...extra,
    }),
  );
  return loadConfig({ configPath: p });
};

describe("brief_file at config load (T5.14)", () => {
  it("is off when unset and resolves to the canonical path when set", () => {
    expect(load(undefined).projects[0]?.briefFile).toBeUndefined();
    const file = path.join(outside, "brief.md");
    writeFileSync(file, BRIEF);
    expect(load(file).projects[0]?.briefFile).toBe(file);
    // A relative path is resolved against the config file's directory.
    expect(load("operator/brief.md").projects[0]?.briefFile).toBe(file);
  });

  it("accepts exactly 4 KiB and refuses one byte more with a clear error", () => {
    const file = path.join(outside, "brief.md");
    writeFileSync(file, "x".repeat(MAX_BRIEF_BYTES));
    expect(load(file).projects[0]?.briefFile).toBe(file);
    writeFileSync(file, "x".repeat(MAX_BRIEF_BYTES + 1));
    expect(() => load(file)).toThrow(/\$\.projects\[0\]\.brief_file: is 4097 bytes; the limit is 4096/);
  });

  it("refuses a brief inside an allowed root or a context, so the agent cannot edit its own brief", () => {
    const inRepo = path.join(roots, "repo", "BRIEF.md");
    writeFileSync(inRepo, BRIEF);
    expect(() => load(inRepo)).toThrow(/brief_file: must be outside every allowed root/);
    // A symlink outside the roots that points inside is judged by its target.
    const link = path.join(outside, "link.md");
    symlinkSync(inRepo, link);
    expect(() => load(link)).toThrow(/brief_file: must be outside every allowed root/);
  });

  it("refuses a missing, empty, non-UTF-8 or non-regular brief file", () => {
    expect(() => load(path.join(outside, "absent.md"))).toThrow(/brief_file: cannot be resolved \(ENOENT\)/);
    const empty = path.join(outside, "empty.md");
    writeFileSync(empty, "");
    expect(() => load(empty)).toThrow(/brief_file: is empty/);
    const binary = path.join(outside, "bin.md");
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00]));
    expect(() => load(binary)).toThrow(/brief_file: is not valid UTF-8/);
    expect(() => load(outside)).toThrow(/brief_file: is not a regular file/);
  });

  it("refuses a brief whose block alone exceeds rag.retrieval.max_context_tokens", () => {
    const file = path.join(outside, "brief.md");
    writeFileSync(file, "y".repeat(MAX_BRIEF_BYTES));
    expect(() => load(file, { rag: { retrieval: { max_context_tokens: 256 } } })).toThrow(
      /brief_file: its block needs about \d+ tokens; rag\.retrieval\.max_context_tokens is 256/,
    );
  });

  it("is a configuration-file key only: a dynamic project definition cannot carry it", () => {
    // `projectSchema` (the dynamic definition, additionalProperties false) has no `brief_file`; a dynamic project could
    // otherwise make the controller read any host file into a prompt (Delegated, least privilege).
    expect("brief_file" in projectSchema.properties).toBe(false);
    expect(() => load(1 as never)).toThrow(/brief_file/);
  });
});

describe("brief at admission and dispatch (T5.14)", () => {
  it("freezes the hash at admission; a later edit does not change what the run gets", () => {
    const file = path.join(outside, "brief.md");
    writeFileSync(file, BRIEF);
    const project = { id: "web", briefFile: file, contexts: [{ path: path.join(roots, "repo") }] };
    const admitted = admitBrief(project as never, [roots]);
    expect(admitted.brief_sha256).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(file, "Edited mid-run.\n");
    expect(frozenBrief(admitted.brief_sha256 as string, file, [roots])?.text).toBe(BRIEF);
    expect(admitBrief({ id: "web", contexts: [] } as never, [roots])).toEqual({});
  });

  it("refuses the run when the brief cannot be read at admission (fail closed, never skipped)", () => {
    const project = { id: "web", briefFile: path.join(outside, "gone.md"), contexts: [] };
    let err: unknown;
    try {
      admitBrief(project as never, [roots]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: "TOOL_FAILURE", details: { project: "web", reason: PROJECT_BRIEF_UNAVAILABLE } });
    expect((err as Error).message).not.toContain(outside);
  });

  it("at dispatch, a hash not in memory is used only if the file still has it", () => {
    const file = path.join(outside, "restart.md");
    writeFileSync(file, "After a restart.\n");
    const { sha256 } = readBriefFile(file, [roots]);
    expect(frozenBrief(sha256, file, [roots])?.text).toBe("After a restart.\n");
    expect(frozenBrief("0".repeat(64), file, [roots])).toBeUndefined();
    expect(frozenBrief("0".repeat(64), undefined, [roots])).toBeUndefined();
    expect(() => freezeBrief(path.join(roots, "repo"), [roots])).toThrow(BriefError);
  });

  it("renders a delimited, labelled block with the hash; the budget counts the block and its separator", () => {
    const brief = { sha256: "c".repeat(64), text: BRIEF };
    const block = renderBriefBlock("web", brief, "0123456789abcdef");
    expect(block.split("\n")[0]).toBe("<switchboard-project-brief 0123456789abcdef>");
    expect(block.endsWith("\n</switchboard-project-brief 0123456789abcdef>")).toBe(true);
    expect(block).toContain(`brief_sha256: ${"c".repeat(64)}\nGoal: ship the parser.`);
    expect(briefBlockTokens("web", brief)).toBe(Math.ceil(Buffer.byteLength(`${block}\n\n`) / 4));
  });
});
