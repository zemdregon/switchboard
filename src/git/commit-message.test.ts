/**
 * Commit-message task through the real tool channel (T11.4; FR-INN-10, FR-GIT-04, LLD §12.1, §12.3, §12.4, §13.5, §13.6,
 * §13.7). Calls arrive over the Unix socket; the inner backend is the scripted in-process fake (no network, no model, no
 * provider CLI). Every commit is read back from the publish ref so the assertion is on what Git actually holds.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createShimServer, shimConfig } from "../cli/tool-shim.js";
import { type ProjectInnerSetting, resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import {
  assembleCommitMessage,
  COMMIT_MESSAGE_SYSTEM,
  commitMessageMode,
  createFakeBackend,
  createInnerAgent,
  type FakeBackend,
  type FakeStep,
  type InnerAgentService,
  PROMPT_PROVIDER_NAMES,
  truncateDiffInput,
  validateCommitMessage,
} from "../inner/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { DynamicProjectStore, innerSettingResolver, toResolved } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { GIT_CHANNEL_OPENED, GitToolService, type OpenChannel } from "./channel.js";
import { GitPublisher, publishRefFor } from "./index.js";
import { COMMIT_INPUT_SCHEMA_MESSAGE_OPTIONAL, MESSAGE_OPTIONAL_FLAG, TOOL_TOKEN_ENV } from "./tool-protocol.js";

/** macOS temp paths (`/private/var/folders/...`) are too long for the 100-byte socket bound (T4.10); `/tmp` is not. */
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : tmpdir();

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const refSha = (cwd: string, ref: string): string => {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const SHIM = [process.execPath, "/nonexistent/bin.js", "tool-shim"];
const NATIVE = "native-ses-4f1c2a9b";
// A planted secret in the `sk-` shape the artifact redactor knows. Assembled so no scanner flags this file.
const SECRET = `sk-${"planted0123456789ABCDEF"}`;

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;
let services: GitToolService[];

beforeEach(() => {
  services = [];
  root = realpathSync(mkdtempSync(path.join(SHORT_TMP, "sb-cmsg-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "Initial import");
  dataDir = path.join(root, "d");
  db = openLedger(dataDir);
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
  });
});

afterEach(async () => {
  for (const s of services) await s.closeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface InnerOpts {
  enabled?: boolean;
  task?: boolean;
  mode?: "draft_if_missing" | "always" | "never";
  allowRemote?: boolean;
  allowSourceContent?: boolean;
  locality?: "local" | "remote";
  script?: readonly FakeStep[];
}

function inner(o: InnerOpts = {}): { svc: InnerAgentService; backend: FakeBackend } {
  const settings = resolveInnerAgent({
    enabled: o.enabled ?? true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:9",
      model: "local-model",
      allow_remote: o.allowRemote ?? false,
    },
    tasks: {
      commit_message: {
        enabled: o.task ?? true,
        ...(o.mode !== undefined ? { mode: o.mode } : {}),
        ...(o.allowSourceContent !== undefined ? { allow_source_content: o.allowSourceContent } : {}),
      },
    },
  });
  const backend = createFakeBackend({ locality: o.locality ?? "local", ...(o.script ? { script: o.script } : {}) });
  const svc = createInnerAgent(settings, {
    backend,
    ledger,
    providerNames: ["claude-code", "codex", "fake", ...PROMPT_PROVIDER_NAMES],
  });
  return { svc, backend };
}

function service(
  opts: { innerAgent?: InnerAgentService; innerSettingFor?: (p: string, c: string) => ProjectInnerSetting } = {},
): GitToolService {
  const s = new GitToolService({
    db,
    dataDir,
    publisher: new GitPublisher({ db, scratchDir: path.join(root, "scratch") }),
    shimCommand: SHIM,
    fallbackDirs: [],
    ...(opts.innerAgent ? { innerAgent: opts.innerAgent } : {}),
    ...(opts.innerSettingFor ? { innerSettingFor: opts.innerSettingFor } : {}),
  });
  services.push(s);
  return s;
}

/** A RUNNING run holding the lease with a real worktree, and one changed file in it. */
async function running() {
  const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    state: "RUNNING",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    provider: "fake",
    projectId: "web",
  });
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: run.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  writeFileSync(path.join(ws.worktreePath, "parser.ts"), `export const parse = (s: string) => s.trim();\n`);
  return { sessionId: session.id, runId: run.id, wt: ws.worktreePath };
}

type Run = Awaited<ReturnType<typeof running>>;

function openFor(s: GitToolService, r: Run): Promise<OpenChannel> {
  return s.open({
    runId: r.runId,
    metaSessionId: r.sessionId,
    worktreePath: r.wt,
    identity: IDENTITY,
    projectId: "web",
    contextId: "main",
    nativeSessionIds: () => [NATIVE],
  });
}

// biome-ignore lint/suspicious/noExplicitAny: wire answers are untyped JSON
type Answer = Record<string, any>;

function call(ch: OpenChannel, args: Record<string, unknown>): Promise<Answer> {
  const line = `${JSON.stringify({ v: 1, token: ch.shim.env[TOOL_TOKEN_ENV], tool: "commit", arguments: args })}\n`;
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: ch.socketPath });
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString("utf8");
    });
    sock.on("close", () => resolve(JSON.parse(buf.split("\n")[0] || '{"closed":true}') as Answer));
    sock.on("connect", () => sock.write(line));
  });
}

const draft = (subject: string, body?: string): FakeStep => ({
  kind: "text",
  text: JSON.stringify(body === undefined ? { subject } : { subject, body }),
});
const committedMessage = (r: Run) => g(repo, "log", "-1", "--format=%B", publishRefFor(r.sessionId));
const innerCalls = (r: Run) => ledger.listInnerCalls({ runId: r.runId });
const commitRows = (r: Run) => ledger.listGitCommits(r.runId);

describe("commit-message task, default mode draft_if_missing (FR-INN-10)", () => {
  it("a hostile backend's trailers, run ID, native session ID and 'generated by' footer never reach the commit", async () => {
    const r = await running();
    const hostile = draft(
      `Trim input in parser ${r.runId}`,
      [
        "Strip surrounding whitespace before parsing.",
        "",
        `See https://claude.ai/chat/${NATIVE} for the session ${r.sessionId}.`,
        "",
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
        "",
        "Co-authored-by: Claude <noreply@anthropic.com>",
        "Co-Authored-By: Codex <codex@example.test>",
        `Claude-Session: https://claude.ai/code/${r.sessionId}`,
      ].join("\n"),
    );
    const { svc, backend } = inner({ script: [hostile] });
    const ch = await openFor(service({ innerAgent: svc }), r);
    const ans = await call(ch, {});
    expect(ans).toMatchObject({ ok: true, result: { files_changed: 1 } });

    const msg = committedMessage(r);
    expect(msg.startsWith("Trim input in parser")).toBe(true);
    expect(msg).toContain("Strip surrounding whitespace before parsing.");
    for (const banned of [
      r.runId,
      r.sessionId,
      NATIVE,
      "Co-authored-by",
      "Co-Authored-By",
      "Generated with",
      "Claude-Session",
    ]) {
      expect(msg, banned).not.toContain(banned);
    }
    expect(msg).not.toMatch(/claude|anthropic|codex/iu);

    // provenance: drafted by the inner agent, linked to its accepted inner_call row; the sanitiser counted removals
    const [row] = commitRows(r);
    const [callRow] = innerCalls(r);
    expect(callRow).toMatchObject({
      task: "commit_message",
      outcome: "accepted",
      template_version: "commit_message.v1",
    });
    expect(row).toMatchObject({ message_source: "inner", inner_call_id: callRow?.id, origin: "commit_tool" });
    const rules = (JSON.parse(row?.sanitizer_json ?? "{}") as { rules: Record<string, number> }).rules;
    expect(rules["trailer.co-author"]).toBe(2);
    expect(rules["footer.generated-by"]).toBeGreaterThanOrEqual(1);
    expect(rules["id.controller"]).toBeGreaterThanOrEqual(1);
    const event = ledger.listRunEvents(r.runId).find((e) => e.type === "git_commit");
    expect(JSON.parse(event?.payload_json ?? "{}")).toMatchObject({
      message_source: "inner",
      inner_call_id: callRow?.id,
    });
    // the message text is stored nowhere in the ledger
    const all = JSON.stringify([ledger.listRunEvents(r.runId), innerCalls(r), commitRows(r)]);
    expect(all).not.toContain("Strip surrounding whitespace");

    // the prompt: the diff of the committed path, and no identifier, provider name or agent text (LLD §13.6)
    expect(backend.requests).toHaveLength(1);
    const req = backend.requests[0];
    expect(req?.system).toBe(COMMIT_MESSAGE_SYSTEM);
    expect(req?.user).toContain("parser.ts");
    expect(req?.user).toContain("+export const parse");
    expect(req?.user).toContain("- Initial import"); // the style hint
    const prompt = `${req?.system}\n${req?.user}`;
    for (const banned of [r.runId, r.sessionId, NATIVE, "switchboard/pub", "switchboard/sess", root]) {
      expect(prompt, banned).not.toContain(banned);
    }
    expect(prompt).not.toMatch(/\b(?:claude|codex|anthropic|openai|fake)\b/iu);
  });

  it("the agent's own message wins: no inner call, no prompt, message_source agent", async () => {
    const r = await running();
    const { svc, backend } = inner({ script: [draft("Drafted subject")] });
    const ch = await openFor(service({ innerAgent: svc }), r);
    expect(await call(ch, { message: "Agent wrote this" })).toMatchObject({ ok: true });
    expect(committedMessage(r)).toBe("Agent wrote this");
    expect(backend.requests).toHaveLength(0);
    expect(innerCalls(r)).toHaveLength(0); // LLD §13.3: a skipped call writes no row
    expect(commitRows(r)[0]).toMatchObject({ message_source: "agent", inner_call_id: null });
    const event = ledger.listRunEvents(r.runId).find((e) => e.type === "git_commit");
    expect(event?.payload_json).not.toContain("message_source");
  });

  it.each([
    ["empty output", [{ kind: "empty" } as FakeStep], "rejected_validator"],
    ["non-JSON output", [{ kind: "text", text: "Fix the parser" } as FakeStep], "rejected_validator"],
    ["a backend error", [{ kind: "error", message: "boom" } as FakeStep], "fallback_unavailable"],
    [
      "a draft that is only trailers",
      [draft(`run_${"0".repeat(26)}`, "Co-authored-by: X <x@example.test>")],
      "rejected_sanitiser",
    ],
  ])("%s returns MESSAGE_REQUIRED and makes no commit", async (_name, script, outcome) => {
    const r = await running();
    const { svc } = inner({ script });
    const ch = await openFor(service({ innerAgent: svc }), r);
    const ans = await call(ch, {});
    expect(ans).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
    expect(ans.error.message).toMatch(/call commit again with a message/u);
    expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
    expect(commitRows(r)).toHaveLength(0);
    expect(innerCalls(r).map((c) => c.outcome)).toEqual([outcome]);
    // the agent can then commit with its own message
    expect(await call(ch, { message: "Agent message" })).toMatchObject({ ok: true });
    expect(committedMessage(r)).toBe("Agent message");
  });

  it("a whitespace-only or over-long agent message is still refused as before", async () => {
    const r = await running();
    const { svc } = inner({ script: [draft("Drafted")] });
    const ch = await openFor(service({ innerAgent: svc }), r);
    expect(await call(ch, { message: "" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await call(ch, { message: "   " })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await call(ch, { message: "x".repeat(8193) })).toMatchObject({
      ok: false,
      error: { code: "MESSAGE_TOO_LONG" },
    });
    expect(await call(ch, { message: 5 })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
  });

  it("a planted secret in the diff is redacted before the prompt, which holds only the committed paths", async () => {
    const r = await running();
    writeFileSync(path.join(r.wt, "config.ts"), `export const key = "${SECRET}";\n`);
    const { svc, backend } = inner({ script: [draft("Add config")] });
    const ch = await openFor(service({ innerAgent: svc }), r);
    expect(await call(ch, { paths: ["config.ts"] })).toMatchObject({ ok: true, result: { files_changed: 1 } });
    expect(backend.requests[0]?.user).toContain("config.ts");
    expect(backend.requests[0]?.user).not.toContain("parser.ts"); // exactly the paths being committed
    expect(backend.requests[0]?.user).not.toContain(SECRET);
  });
});

describe("modes always and never", () => {
  it("always: a valid draft is used even when the agent gave a message, which is never sent", async () => {
    const r = await running();
    const { svc, backend } = inner({ mode: "always", script: [draft("Trim parser input")] });
    const ch = await openFor(service({ innerAgent: svc }), r);
    expect(await call(ch, { message: "agent-text-7d1e" })).toMatchObject({ ok: true });
    expect(committedMessage(r)).toBe("Trim parser input");
    expect(backend.requests[0]?.user).not.toContain("agent-text-7d1e");
    expect(commitRows(r)[0]?.message_source).toBe("inner");
  });

  it("always: an unusable draft falls back to the agent's message, and to MESSAGE_REQUIRED without one", async () => {
    const r = await running();
    const { svc } = inner({ mode: "always", script: [{ kind: "error" }] });
    const ch = await openFor(service({ innerAgent: svc }), r);
    expect(await call(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
    expect(await call(ch, { message: "Agent fallback" })).toMatchObject({ ok: true });
    expect(committedMessage(r)).toBe("Agent fallback");
    expect(commitRows(r)[0]).toMatchObject({ message_source: "agent", inner_call_id: null });
  });

  it("never, a disabled task, a disabled agent or no service: the tool is exactly as before", async () => {
    for (const svcOpts of [{ mode: "never" as const }, { task: false }, { enabled: false }, undefined]) {
      const r = await running();
      const made = svcOpts === undefined ? undefined : inner({ ...svcOpts, script: [draft("Drafted")] });
      if (made) expect(commitMessageMode(made.svc)).toBeUndefined();
      const ch = await openFor(service(made ? { innerAgent: made.svc } : {}), r);
      expect(ch.shim.command).toEqual([...SHIM, "--socket", ch.socketPath, "--tools", "commit"]);
      const opened = ledger.listRunEvents(r.runId).find((e) => e.type === GIT_CHANNEL_OPENED);
      expect(opened?.payload_json).not.toContain("commit_message");
      expect(await call(ch, {})).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
      expect(await call(ch, { message: "Plain" })).toMatchObject({ ok: true });
      expect(committedMessage(r)).toBe("Plain");
      expect(made?.backend.requests ?? []).toHaveLength(0);
      expect(innerCalls(r)).toHaveLength(0);
    }
  });

  it("an enabled task opens the channel with message optional for the shim", async () => {
    const r = await running();
    const { svc } = inner();
    const ch = await openFor(service({ innerAgent: svc }), r);
    expect(ch.shim.command).toEqual([...SHIM, "--socket", ch.socketPath, "--tools", "commit", MESSAGE_OPTIONAL_FLAG]);
    const opened = ledger.listRunEvents(r.runId).find((e) => e.type === GIT_CHANNEL_OPENED);
    expect(JSON.parse(opened?.payload_json ?? "{}")).toMatchObject({ commit_message: "draft_if_missing" });
    const token = "sbt1_".padEnd(48, "A");
    const cfg = shimConfig(ch.shim.command.slice(SHIM.length), { [TOOL_TOKEN_ENV]: token });
    expect(cfg).toMatchObject({ tools: ["commit"], messageOptional: true });
    expect(shimConfig(["--socket", "/x/tools.sock"], { [TOOL_TOKEN_ENV]: token }).messageOptional).toBeUndefined();
    expect(shimConfig(["--socket", "/x/tools.sock", MESSAGE_OPTIONAL_FLAG], { [TOOL_TOKEN_ENV]: token })).toMatchObject(
      { tools: ["commit"], messageOptional: true },
    );
    expect(COMMIT_INPUT_SCHEMA_MESSAGE_OPTIONAL).not.toHaveProperty("required");
    expect(createShimServer(cfg)).toBeDefined();
  });
});

describe("privacy gates and the project setting (LLD §13.5)", () => {
  it("a remote backend gets no diff without allow_remote and the per-task opt-in", async () => {
    for (const [o, reason] of [
      [{ locality: "remote", allowRemote: false }, "REMOTE_NOT_ALLOWED"],
      [{ locality: "remote", allowRemote: true }, "SOURCE_CONTENT_NOT_ALLOWED"],
    ] as const) {
      const r = await running();
      const { svc, backend } = inner({ ...o, script: [draft("Remote draft")] });
      const ch = await openFor(service({ innerAgent: svc }), r);
      expect(await call(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
      expect(backend.requests).toHaveLength(0);
      expect(innerCalls(r).map((c) => [c.outcome, c.reason, c.input_bytes])).toEqual([
        [`fallback_disabled`, reason, 0],
      ]);
      expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
    }
    const r = await running();
    const { svc, backend } = inner({
      locality: "remote",
      allowRemote: true,
      allowSourceContent: true,
      script: [draft("Remote draft")],
    });
    const ch = await openFor(service({ innerAgent: svc }), r);
    expect(await call(ch, {})).toMatchObject({ ok: true });
    expect(backend.requests).toHaveLength(1);
    expect(committedMessage(r)).toBe("Remote draft");
  });

  it("project setting off at open keeps message required and never calls the backend", async () => {
    const r = await running();
    const { svc, backend } = inner({ script: [draft("Drafted")] });
    const seen: string[] = [];
    const ch = await openFor(
      service({
        innerAgent: svc,
        innerSettingFor: (p, c) => {
          seen.push(`${p}/${c}`);
          return "off";
        },
      }),
      r,
    );
    expect(seen).toEqual(["web/main"]);
    expect(ch.shim.command).not.toContain(MESSAGE_OPTIONAL_FLAG);
    expect(await call(ch, {})).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await call(ch, { message: "Agent" })).toMatchObject({ ok: true });
    expect(backend.requests).toHaveLength(0);
    expect(innerCalls(r)).toHaveLength(0);
  });

  it("a resolver that throws is read as off", async () => {
    const r = await running();
    const { svc } = inner();
    const ch = await openFor(
      service({
        innerAgent: svc,
        innerSettingFor: () => {
          throw new Error("no project");
        },
      }),
      r,
    );
    expect(ch.shim.command).not.toContain(MESSAGE_OPTIONAL_FLAG);
  });

  it("the setting is resolved again at call time: off or local_only after open denies the draft", async () => {
    let setting: ProjectInnerSetting = "inherit";
    const r = await running();
    const { svc, backend } = inner({ locality: "remote", allowRemote: true, allowSourceContent: true });
    const ch = await openFor(service({ innerAgent: svc, innerSettingFor: () => setting }), r);
    expect(ch.shim.command).toContain(MESSAGE_OPTIONAL_FLAG);
    setting = "local_only";
    expect(await call(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
    setting = "off";
    expect(await call(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
    expect(backend.requests).toHaveLength(0);
    expect(innerCalls(r).map((c) => c.reason)).toEqual(["PROJECT_LOCAL_ONLY", "PROJECT_OFF"]);
  });

  it("local_only still uses a local backend", async () => {
    const r = await running();
    const { svc, backend } = inner({ script: [draft("Local draft")] });
    const ch = await openFor(service({ innerAgent: svc, innerSettingFor: () => "local_only" }), r);
    expect(await call(ch, {})).toMatchObject({ ok: true });
    expect(backend.requests).toHaveLength(1);
    expect(committedMessage(r)).toBe("Local draft");
  });
});

describe("innerSettingResolver (serve wiring, LLD §13.1)", () => {
  it("reads configured and dynamic projects, most restrictive of project and context, unknown is off", () => {
    const ctx = (inner_agent?: "off" | "local_only" | "inherit") => ({
      id: "main",
      kind: "repository" as const,
      path: repo,
      base_ref: "main",
      ...(inner_agent ? { inner_agent } : {}),
    });
    const configured = [
      toResolved({ id: "plain", name: "Plain", contexts: [ctx()] }),
      toResolved({ id: "local", name: "Local", inner_agent: "local_only", contexts: [ctx()] }),
      toResolved({ id: "ctxoff", name: "Ctx off", inner_agent: "local_only", contexts: [ctx("off")] }),
    ];
    const store = new DynamicProjectStore(db, { ids: createIdGenerator() });
    store.appendRevision(
      {
        projectId: "dyn-app",
        clientId: "c1",
        definition: { id: "dyn-app", name: "Dyn", inner_agent: "off", contexts: [ctx()] },
        status: "ACTIVE",
        approvalReasons: [],
        action: "create_project",
      },
      () => undefined,
    );
    const resolve = innerSettingResolver(configured, store);
    expect(resolve("plain", "main")).toBe("inherit");
    expect(resolve("local", "main")).toBe("local_only");
    expect(resolve("ctxoff", "main")).toBe("off");
    expect(resolve("dyn-app", "main")).toBe("off");
    expect(resolve("missing", "main")).toBe("off");
  });
});

describe("task contract helpers (LLD §13.6)", () => {
  it("validates the subject and assembles subject and body", () => {
    expect(validateCommitMessage({ subject: "Fix parser" })).toBeNull();
    expect(validateCommitMessage({ subject: "fix: parser" })).toBeNull(); // a conventional-commit prefix is fine
    expect(validateCommitMessage({ subject: "Fix\nparser" })).not.toBeNull();
    expect(validateCommitMessage({ subject: " Fix" })).not.toBeNull();
    expect(validateCommitMessage({ subject: "Fix\tparser" })).not.toBeNull();
    expect(validateCommitMessage({ subject: "```js" })).not.toBeNull();
    expect(validateCommitMessage({ subject: "Co-authored-by: X <x@y>" })).not.toBeNull();
    expect(validateCommitMessage({ subject: "Fix", body: "a\u0007b" })).not.toBeNull();
    expect(assembleCommitMessage({ subject: "Fix", body: "  " })).toBe("Fix");
    expect(assembleCommitMessage({ subject: "Fix", body: "Why.\n" })).toBe("Fix\n\nWhy.");
  });

  it("truncates a diff to whole hunks in path order, keeping the path list and the marker", () => {
    const hunk = (n: number) => `@@ -${n},1 +${n},1 @@\n-${"o".repeat(40)}\n+${"n".repeat(40)}\n`;
    const file = (p: string) =>
      `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n${hunk(1)}${hunk(9)}`;
    const header =
      "Changed paths (added<TAB>deleted<TAB>path):\n2\t2\ta.ts\n2\t2\tb.ts\n\nRecent subjects (style hint):\n(none)\n\nDiff:\n";
    const text = `${header}${file("a.ts")}${file("b.ts")}`;
    expect(truncateDiffInput(text, 100_000)).toEqual({ text, omitted: 0 });
    const budget = Buffer.byteLength(header) + Buffer.byteLength(file("a.ts")) + 60;
    const out = truncateDiffInput(text, budget);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(budget);
    expect(out.text.startsWith(header)).toBe(true);
    expect(out.text).toContain(file("a.ts"));
    expect(out.text).not.toContain("b/b.ts");
    expect(out.text).toMatch(/\[truncated: \d+ bytes omitted\]\n$/u);
    // a hunk is never split
    const mid = truncateDiffInput(text, Buffer.byteLength(header) + 150);
    expect(mid.text).not.toContain("@@ -9,1");
    for (const line of mid.text.split("\n"))
      if (line.startsWith("+n") || line.startsWith("-o")) expect(line.length).toBe(41);
  });
});
