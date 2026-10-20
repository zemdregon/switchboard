/**
 * PR-draft task (T11.8; FR-INN-11, BR-38, LLD §3 `get_artifacts`, §13.4 step 10, §13.5, §13.6, §13.7). The inner backend is
 * the scripted in-process fake: no network, no model, no provider CLI. The repository is a real temporary Git repo so the
 * gathered diff is what Git holds.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { isAllowedGhArgv } from "../ci/gh-argv.js";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createSanitizer } from "../git/sanitize.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { MCP_ARTIFACT_KINDS } from "../mcp/schemas.js";
import {
  allChecksPassed,
  buildPrDraftInput,
  createFakeBackend,
  createInnerAgent,
  createPrDraft,
  type FakeBackend,
  type FakeStep,
  PR_DRAFT_SCHEMA,
  PR_DRAFT_UNAVAILABLE_MESSAGE,
  PROMPT_PROVIDER_NAMES,
  type PrDraftDeps,
  validatePrDraft,
} from "./index.js";

// Every program started through `node:child_process` while a draft is made (the T11.8 "Done when" suite reads it). The
// wrappers forward to the real functions, so the Git runner and the test's own Git helper behave as without the mock.
const spawned = vi.hoisted(() => ({ programs: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const wrap = <F extends (...args: never[]) => unknown>(fn: F): F =>
    ((file: string, ...rest: unknown[]) => {
      spawned.programs.push(file);
      return (fn as unknown as (...a: unknown[]) => unknown)(file, ...rest);
    }) as unknown as F;
  return {
    ...real,
    execFile: wrap(real.execFile),
    execFileSync: wrap(real.execFileSync),
    spawn: wrap(real.spawn),
    spawnSync: wrap(real.spawnSync),
    exec: wrap(real.exec),
    execSync: wrap(real.execSync),
    fork: wrap(real.fork),
  };
});

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

// A planted secret in the `sk-` shape the artifact redactor knows. Assembled so no scanner flags this file.
const SECRET = `sk-${"planted0123456789ABCDEF"}`;

let root: string;
let repo: string;
let db: Database.Database;
let ledger: Ledger;
let store: ArtifactStore;
let sessionId: string;
let runId: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-prdraft-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "Initial import");
  db = openLedger(path.join(root, "d"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new ArtifactStore(path.join(root, "d", "artifacts"));
  const session = ledger.createMetaSession({ objective: "test" });
  sessionId = session.id;
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  runId = run.id;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Two controller-made commits on the run (made with plain Git, recorded the way the publisher records them). */
function commitTwice(): void {
  writeFileSync(path.join(repo, "widget.ts"), `export const widget = 1;\nconst token = "${SECRET}";\n`);
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "Add widget");
  record();
  writeFileSync(path.join(repo, "widget.ts"), "export const widget = 2;\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "Bump widget");
  record();
}
function record(): void {
  ledger.recordGitCommit({
    commitSha: g(repo, "rev-parse", "HEAD"),
    treeSha: g(repo, "rev-parse", "HEAD^{tree}"),
    repoRoot: repo,
    publishRef: `refs/heads/switchboard/pub/${sessionId}`,
    projectId: "web",
    contextId: "main",
    metaSessionId: sessionId,
    runId,
    provider: "fake",
    harness: "fake",
    origin: "commit_tool",
    sanitizer: { rules: {} },
    eventPayload: {},
  });
}

interface Opts {
  enabled?: boolean;
  task?: boolean;
  locality?: "local" | "remote";
  allowRemote?: boolean;
  allowSourceContent?: boolean;
  script?: readonly FakeStep[];
}
function deps(o: Opts = {}): { deps: PrDraftDeps; backend: FakeBackend } {
  const settings = resolveInnerAgent({
    enabled: o.enabled ?? true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:9",
      model: "local-model",
      allow_remote: o.allowRemote ?? false,
    },
    tasks: {
      pr_draft: {
        enabled: o.task ?? true,
        ...(o.allowSourceContent !== undefined ? { allow_source_content: o.allowSourceContent } : {}),
      },
    },
  });
  const backend = createFakeBackend({ locality: o.locality ?? "local", ...(o.script ? { script: o.script } : {}) });
  const service = createInnerAgent(settings, {
    backend,
    ledger,
    providerNames: ["claude-code", "codex", "fake", ...PROMPT_PROVIDER_NAMES],
  });
  return { deps: { service, ledger, artifacts: store }, backend };
}
const text = (value: unknown): FakeStep => ({ kind: "text", text: JSON.stringify(value) });
const prArtifacts = () => ledger.listArtifactsForRun(runId).filter((a) => a.kind === "pr_draft");
const callRows = () => ledger.listInnerCalls({ runId });

describe("pr_draft task", () => {
  it("a hostile backend (trailers, run IDs, generated-by footers) yields a clean stored draft", async () => {
    commitTwice();
    const hostile = {
      title: "Add widget module",
      body: [
        "Adds a widget and bumps it.",
        "",
        `Run ${runId} in ${sessionId} did this.`,
        "Co-authored-by: Bot <bot@example.test>",
        "Generated-by: Some Tool",
        "Generated with Claude Code",
        "Claude-Session: https://claude.ai/code/session_01abc",
        "",
      ].join("\n"),
    };
    const { deps: d, backend } = deps({ script: [text(hostile)] });
    const r = await createPrDraft(d, { runId, nativeSessionIds: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe("Add widget module");
    expect(r.body).toContain("Adds a widget and bumps it.");
    for (const bad of [/Co-authored-by/iu, /Generated[- ]/iu, /Claude-Session/iu, /claude\.ai/iu, runId, sessionId]) {
      expect(r.body).not.toMatch(bad);
    }
    // stored as a `pr_draft` artifact: application/json, the same sanitised text, referenced by the inner_call event
    const [art] = prArtifacts();
    expect(art).toMatchObject({ id: r.artifactId, kind: "pr_draft", media_type: "application/json", run_id: runId });
    const stored = JSON.parse((await store.get(art?.sha256 ?? "")).toString("utf8"));
    expect(stored).toEqual({ title: r.title, body: r.body });
    const ev = ledger.listRunEvents(runId).find((e) => e.type === "inner_call");
    expect(ev?.artifact_id).toBe(r.artifactId);
    expect(callRows().map((c) => [c.task, c.outcome])).toEqual([["pr_draft", "accepted"]]);
    // the prompt: diff and file list present, no identifier, no planted secret
    const prompt = backend.requests.map((q) => JSON.stringify(q)).join("\n");
    expect(prompt).toContain("widget.ts");
    expect(prompt).toContain("Add widget");
    for (const leaked of [runId, sessionId, SECRET, root]) expect(prompt).not.toContain(leaked);
    // `get_artifacts` can return the kind
    expect(MCP_ARTIFACT_KINDS).toContain("pr_draft");
  });

  it("the diff spans the whole run, from the parent of the first commit to the last", async () => {
    commitTwice();
    const { deps: d, backend } = deps({ script: [text({ title: "T", body: "B" })] });
    await createPrDraft(d, { runId });
    const prompt = backend.requests[0]?.user ?? JSON.stringify(backend.requests[0]);
    expect(prompt).toContain("Commit subjects (oldest first):");
    expect(prompt.indexOf("Add widget")).toBeLessThan(prompt.indexOf("Bump widget"));
    expect(prompt).toContain("+export const widget = 2;");
  });

  it.each([
    ["empty output", { kind: "empty" } as FakeStep],
    ["backend error", { kind: "error" } as FakeStep],
    ["not JSON", { kind: "text", text: "just prose" } as FakeStep],
    ["schema violation", text({ title: "", body: "x" })],
    ["extra property", text({ title: "T", body: "B", extra: 1 })],
    ["multi-line title", text({ title: "A\nB", body: "B" })],
    ["body only a trailer line", text({ title: "T", body: "Co-authored-by: Bot <bot@example.test>" })],
    ["success claim without facts", text({ title: "T", body: "All tests pass." })],
    ["added URL", text({ title: "T", body: "See https://example.test/x for details." })],
  ])("%s yields no artifact and the fixed answer", async (_name, step) => {
    commitTwice();
    const { deps: d } = deps({ script: [step] });
    const r = await createPrDraft(d, { runId });
    expect(r).toEqual({ ok: false, code: "PR_DRAFT_UNAVAILABLE", message: PR_DRAFT_UNAVAILABLE_MESSAGE });
    expect(prArtifacts()).toEqual([]);
    expect(callRows().every((c) => c.outcome !== "accepted")).toBe(true);
  });

  it("records the right rejection outcomes", async () => {
    commitTwice();
    await createPrDraft(deps({ script: [text({ title: "T", body: "Co-authored-by: Bot <b@e.test>" })] }).deps, {
      runId,
    });
    await createPrDraft(deps({ script: [text({ title: "T", body: "All tests pass." })] }).deps, { runId });
    expect(callRows().map((c) => c.outcome)).toEqual(["rejected_sanitiser", "rejected_validator"]);
  });

  it("a success claim is accepted when the recorded verification facts all passed", async () => {
    commitTwice();
    ledger.appendRunEvent({
      runId,
      type: "verification_command",
      payload: { index: 0, outcome: "passed", exit_code: 0 },
    });
    const { deps: d, backend } = deps({ script: [text({ title: "T", body: "All tests pass." })] });
    const r = await createPrDraft(d, { runId });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(backend.requests[0])).toContain("check 1: passed");
    expect(allChecksPassed([{ label: "a", outcome: "passed" }])).toBe(true);
    expect(
      allChecksPassed([
        { label: "a", outcome: "passed" },
        { label: "b", outcome: "failed" },
      ]),
    ).toBe(false);
    expect(allChecksPassed([])).toBe(false);
  });

  it("a failed check blocks a success claim", async () => {
    commitTwice();
    ledger.appendRunEvent({
      runId,
      type: "verification_command",
      payload: { index: 0, outcome: "failed", exit_code: 1 },
    });
    const r = await createPrDraft(deps({ script: [text({ title: "T", body: "All tests pass." })] }).deps, { runId });
    expect(r.ok).toBe(false);
  });

  it("a task that is not enabled, a disabled agent and a run with no commits make no call and write nothing", async () => {
    commitTwice();
    for (const o of [{ task: false }, { enabled: false }]) {
      const { deps: d, backend } = deps(o);
      expect(await createPrDraft(d, { runId })).toMatchObject({ ok: false, code: "PR_DRAFT_UNAVAILABLE" });
      expect(backend.requests).toHaveLength(0);
    }
    const other = ledger.createRun({
      metaSessionId: sessionId,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h2",
      clientId: "c",
    });
    const { deps: d, backend } = deps({ script: [text({ title: "T", body: "B" })] });
    expect(await createPrDraft(d, { runId: other.id })).toMatchObject({ ok: false });
    expect(backend.requests).toHaveLength(0);
    expect(callRows()).toEqual([]);
    expect(prArtifacts()).toEqual([]);
  });

  it("privacy gates apply to diffs as for commit messages (LLD §13.5)", async () => {
    commitTwice();
    const ok = text({ title: "T", body: "B" });
    const cases: [Opts, { projectSetting?: "off" | "local_only" | "inherit" }, boolean, string?][] = [
      [{ locality: "local" }, {}, true],
      [{ locality: "local" }, { projectSetting: "off" }, false, "PROJECT_OFF"],
      [{ locality: "remote" }, { projectSetting: "local_only" }, false, "PROJECT_LOCAL_ONLY"],
      [{ locality: "remote", allowRemote: false }, {}, false, "REMOTE_NOT_ALLOWED"],
      [{ locality: "remote", allowRemote: true }, {}, false, "SOURCE_CONTENT_NOT_ALLOWED"],
      [{ locality: "remote", allowRemote: true, allowSourceContent: true }, {}, true],
    ];
    for (const [o, req, allowed, reason] of cases) {
      const before = callRows().length;
      const { deps: d, backend } = deps({ ...o, script: [ok] });
      const r = await createPrDraft(d, { runId, ...req });
      expect(r.ok).toBe(allowed);
      expect(backend.requests.length > 0).toBe(allowed);
      const row = callRows()[before];
      expect(row?.outcome).toBe(allowed ? "accepted" : "fallback_disabled");
      if (reason !== undefined) expect(row?.reason).toBe(reason);
    }
  });

  it("redacts a planted secret from the stored draft", async () => {
    commitTwice();
    const { deps: d } = deps({ script: [text({ title: "T", body: `Rotate the key ${SECRET} soon.` })] });
    const r = await createPrDraft(d, { runId });
    expect(r.ok).toBe(true);
    const [art] = prArtifacts();
    expect((await store.get(art?.sha256 ?? "")).toString("utf8")).not.toContain(SECRET);
  });

  it("an artifact-store failure is the fixed answer and no artifact", async () => {
    commitTwice();
    const { deps: d } = deps({ script: [text({ title: "T", body: "B" })] });
    const broken = {
      ...d,
      artifacts: { put: () => Promise.reject(new Error("disk full")), redactContent: (b: Buffer) => b },
    };
    expect(await createPrDraft(broken, { runId })).toMatchObject({ ok: false, code: "PR_DRAFT_UNAVAILABLE" });
    expect(prArtifacts()).toEqual([]);
    expect(callRows().map((c) => [c.outcome, c.reason])).toEqual([["fallback_unavailable", "PERSIST_FAILED"]]);
  });

  it("validator and input unit checks", () => {
    expect(PR_DRAFT_SCHEMA.additionalProperties).toBe(false);
    const ok = { title: "Add x", body: "Adds x." };
    expect(validatePrDraft(ok, "", [])).toBeNull();
    expect(validatePrDraft({ ...ok, title: " Add x" }, "", [])).toBe("title_space");
    expect(validatePrDraft({ ...ok, title: "Co-authored-by: a" }, "", [])).toBe("title_trailer");
    expect(validatePrDraft({ ...ok, body: "  " }, "", [])).toBe("body_blank");
    expect(validatePrDraft({ ...ok, body: "see http://a.test/x" }, "http://a.test/x in diff", [])).toBeNull();
    const input = buildPrDraftInput({ commitSubjects: [], numstat: "", diff: "", facts: [] }, 4000);
    expect(input).toContain("(none recorded)");
  });
});

describe("Switchboard makes no pull-request API call (FR-INN-11, BR-38)", () => {
  /**
   * Scan logic: a pull-request client would show up as (a) a source module named for a forge client (`octokit`,
   * `github`/`gitlab`/`bitbucket` API client files) or (b) a string that names a forge's pull-request endpoint or host.
   * Test files are excluded because this file and the sanitiser tests legitimately name such strings. The scan is
   * evidence, not proof: it cannot show that no code could ever build such a URL at run time, which is why the pr_draft
   * module also has no network import at all (checked below). Dependencies are checked through package.json.
   */
  const SRC = path.resolve(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/u.test(name) && !/\.test\.ts$/u.test(name)) files.push(full);
    }
  };
  walk(SRC);

  // ADR-0069 (owner decision 78, FRD BR-38 note 2026-10-20): the one module allowed to build a pull-request argv is the
  // audited operator-`gh` template module, used only by MCP `publish_run`; the inner agent never reaches it.
  const PR_ARGV_ALLOWED = new Set(["ci/gh-argv.ts"]);

  it("no source module is, or names, a pull-request API client (except the audited gh argv of ADR-0069)", () => {
    expect(files.length).toBeGreaterThan(50);
    const nameRe = /(octokit|github|gitlab|bitbucket|gitea)[^/]*\.ts$|pull[-_]?request|merge[-_]?request/iu;
    expect(files.filter((f) => nameRe.test(path.relative(SRC, f)))).toEqual([]);
    const contentRe =
      /api\.github\.com|gitlab\.com\/api|api\.bitbucket\.org|\/repos\/[^"'`\s]*\/pulls|\/merge_requests|\/pull-requests\b|gh\s+pr\s+(?:create|edit|comment)|"pr",\s*"create"/iu;
    const hits = files.filter((f) => contentRe.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
    expect(hits).toEqual([...PR_ARGV_ALLOWED]);
    // No module under src/inner imports the gh argv, the gh ports or the publish tool.
    const inner = files.filter((f) => path.relative(SRC, f).startsWith(`inner${path.sep}`));
    for (const f of inner) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/ci\/gh-(?:argv|port|pr)\.js|mcp\/publish\.js/u);
    }
  });

  it("no dependency is a forge client, and the pr_draft module imports no network or process API", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(SRC, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((n) => /octokit|github|gitlab|bitbucket|gitea/iu.test(n))).toEqual([]);
    const src = readFileSync(path.join(SRC, "inner", "pr-draft.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'](?:node:)?(?:https?|http2|net|tls|dgram|child_process)["']|\bfetch\s*\(/u);
  });
});

describe("pr_draft task: roadmap 'Done when' (T11.8)", () => {
  const NATIVE = "native-sess-4f2a9c";
  const hostile = () => ({
    title: `Add widget module ${runId}`,
    body: [
      "Adds a widget and bumps it.",
      "",
      `Session ${NATIVE} of ${sessionId}.`,
      "Co-authored-by: Bot <bot@example.test>",
      "Signed-off-by: Claude <noreply@anthropic.com>",
      "Generated-by: Some Tool",
      "Generated with Claude Code",
      "Claude-Session: https://claude.ai/code/session_01abc",
    ].join("\n"),
  });

  it("draft passes the sanitiser: the stored draft is a fixed point of the commit-message sanitiser", async () => {
    commitTwice();
    const raw = hostile();
    const sanitizer = createSanitizer({ nativeSessionIds: [NATIVE] });
    // Not vacuous: the same sanitiser removes something from the raw backend output.
    const removed = (t: string) => Object.values(sanitizer.sanitize(t).report.rules).reduce((a, n) => a + n, 0);
    expect(removed(raw.title) + removed(raw.body)).toBeGreaterThan(0);
    const { deps: d } = deps({ script: [text(raw)] });
    const r = await createPrDraft(d, { runId, nativeSessionIds: [NATIVE] });
    expect(r.ok).toBe(true);
    const [art] = prArtifacts();
    const stored = JSON.parse((await store.get(art?.sha256 ?? "")).toString("utf8")) as { title: string; body: string };
    for (const field of [stored.title, stored.body]) {
      const again = sanitizer.sanitize(field);
      expect(again.message).toBe(field);
      expect(removed(field)).toBe(0);
    }
    for (const leaked of [runId, sessionId, NATIVE, "Co-authored-by", "Signed-off-by", "Generated", "claude.ai"]) {
      expect(`${stored.title}\n${stored.body}`).not.toContain(leaked);
    }
  });

  it("makes no network call and starts no program but git while drafting", async () => {
    commitTwice();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    spawned.programs.length = 0;
    try {
      const { deps: d } = deps({ script: [text({ title: "Add widget", body: "Adds a widget." })] });
      const r = await createPrDraft(d, { runId });
      expect(r.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Not vacuous: the draft reads the run's diff through Git, so the recorder saw it.
      expect(spawned.programs.length).toBeGreaterThan(0);
      expect(new Set(spawned.programs)).toEqual(new Set(["git"]));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("the only gh argv allowlist in src/ (the CI-failure trigger) admits no pull-request call", () => {
    const pullRequestArgv: string[][] = [
      ["pr", "create", "--title", "T", "--body", "B"],
      ["pr", "edit", "1", "--body", "B"],
      ["pr", "comment", "1", "--body", "B"],
      ["pr", "review", "1", "--approve"],
      ["pr", "merge", "1", "--squash"],
      ["pr", "ready", "1"],
      ["api", "repos/o/r/pulls", "--paginate", "--jq", "."],
      ["api", "-X", "POST", "repos/o/r/pulls", "-f", "title=T"],
      ["api", "-X", "POST", "repos/o/r/issues/1/comments", "-f", "body=B"],
      ["api", "graphql", "-f", "query=mutation{createPullRequest}"],
    ];
    expect(pullRequestArgv.filter((argv) => isAllowedGhArgv(argv))).toEqual([]);
  });
});
