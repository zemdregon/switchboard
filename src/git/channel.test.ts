/**
 * `COMP-GIT` tool service, adversarial (T9.4; FR-GIT-02, LLD §12.2; ADR-0026). Calls arrive over the real Unix socket
 * from a raw client, so every framing and token case the shim would never send is exercised. Temporary repositories
 * only; no provider CLI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore, defaultRedactor } from "../artifacts/index.js";
import { forward, shimConfig } from "../cli/tool-shim.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  type ChannelLimits,
  ChannelOpenError,
  GIT_CHANNEL_CLOSED,
  GIT_CHANNEL_OPENED,
  GIT_TOOL_DENIED,
  GitToolService,
  type OpenChannel,
} from "./channel.js";
import { GitPublisher, type GitPublisherOptions, publishRefFor } from "./index.js";
import { MAX_REQUEST_BYTES, MAX_SOCKET_PATH_BYTES, TOKEN_PREFIX, TOOL_TOKEN_ENV } from "./tool-protocol.js";

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

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;
let services: GitToolService[];

beforeEach(() => {
  services = [];
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-chan-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
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

function service(
  opts: {
    limits?: Partial<ChannelLimits>;
    dataDir?: string;
    fallbackDirs?: string[];
    publisher?: Partial<GitPublisherOptions>;
  } = {},
): GitToolService {
  const publisher = new GitPublisher({ db, scratchDir: path.join(root, "scratch"), ...opts.publisher });
  const s = new GitToolService({
    db,
    dataDir: opts.dataDir ?? dataDir,
    publisher,
    shimCommand: SHIM,
    fallbackDirs: opts.fallbackDirs ?? [],
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  services.push(s);
  return s;
}

/** A RUNNING run holding the lease with a real worktree. */
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
  return { sessionId: session.id, runId: run.id, wt: ws.worktreePath };
}

async function openFor(s: GitToolService, r: { sessionId: string; runId: string; wt: string }): Promise<OpenChannel> {
  return s.open({
    runId: r.runId,
    metaSessionId: r.sessionId,
    worktreePath: r.wt,
    identity: IDENTITY,
    projectId: "web",
    contextId: "main",
  });
}

const tokenOf = (ch: OpenChannel) => ch.shim.env[TOOL_TOKEN_ENV] as string;
const req = (token: string, args: Record<string, unknown> = { message: "Add b" }, tool = "commit") =>
  `${JSON.stringify({ v: 1, token, tool, arguments: args })}\n`;

// biome-ignore lint/suspicious/noExplicitAny: wire answers are untyped JSON
type Answer = Record<string, any>;

/** Send raw bytes (optionally in pieces, optionally leaving the request unterminated) and read the one-line answer. */
function raw(socketPath: string, data: string | Buffer, opts: { end?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: socketPath });
    let buf = "";
    sock.on("error", () => {}); // the answer, if any, was already read; "close" decides
    sock.on("data", (d) => {
      buf += d.toString("utf8");
    });
    sock.on("close", () => {
      const line = buf.split("\n")[0] ?? "";
      if (line === "") resolve({ closed: true });
      else resolve(JSON.parse(line) as Answer);
    });
    sock.on("connect", () => {
      sock.write(data, () => {
        if (opts.end) sock.end();
      });
    });
  });
}

const denied = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === GIT_TOOL_DENIED)
    .map((e) => JSON.parse(e.payload_json) as { code: string });
const types = (runId: string) => ledger.listRunEvents(runId).map((e) => e.type);

describe("channel setup (LLD §12.2)", () => {
  it("creates a 0600 socket in a 0700 directory owned by this user, under <data_dir>/runs/<run_id>", async () => {
    const r = await running();
    const ch = await openFor(service(), r);
    expect(ch.socketPath).toBe(path.join(dataDir, "runs", r.runId, "tools.sock"));
    const sock = lstatSync(ch.socketPath);
    expect(sock.isSocket()).toBe(true);
    expect(sock.mode & 0o777).toBe(0o600);
    const dir = lstatSync(path.dirname(ch.socketPath));
    expect(dir.mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(dataDir, "runs")).mode & 0o777).toBe(0o700);
    expect(dir.uid).toBe(process.getuid?.());
    expect(ch.shim.command).toEqual([...SHIM, "--socket", ch.socketPath]);
    expect(ch.shim.toolNames).toEqual(["commit"]);
    expect(Object.keys(ch.shim.env)).toEqual([TOOL_TOKEN_ENV]);
    expect(tokenOf(ch)).toMatch(/^sbt1_[A-Za-z0-9_-]{43}$/u);
    // The token is 256 random bits, different per channel, and not recorded.
    const other = await running();
    const ch2 = await openFor(services[0] as GitToolService, other);
    expect(tokenOf(ch2)).not.toBe(tokenOf(ch));
    const opened = ledger.listRunEvents(r.runId).find((e) => e.type === GIT_CHANNEL_OPENED);
    expect(opened?.payload_json).not.toContain(tokenOf(ch).slice(TOKEN_PREFIX.length));
  });

  it("falls back to a short private directory when the data-directory path is too long, and refuses when none fits", async () => {
    const r = await running();
    const longData = path.join(root, "x".repeat(60), "y".repeat(60));
    const s = service({
      dataDir: longData,
      fallbackDirs: ["relative/ignored", path.join(root, "z".repeat(200)), root],
    });
    const ch = await openFor(s, r);
    expect(Buffer.byteLength(ch.socketPath)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(path.basename(path.dirname(ch.socketPath))).toMatch(/^sb-git-/u);
    expect(path.dirname(path.dirname(ch.socketPath))).toBe(root);
    expect(lstatSync(path.dirname(ch.socketPath)).mode & 0o777).toBe(0o700);
    expect(existsSync(longData)).toBe(false); // nothing is created under the long path
    const ans = await raw(ch.socketPath, req(tokenOf(ch), { message: "nothing yet" }));
    expect(ans).toMatchObject({ ok: false, error: { code: "NOTHING_TO_COMMIT" } }); // the channel works
    await ch.close();
    expect(existsSync(path.dirname(ch.socketPath))).toBe(false);

    const r2 = await running();
    await expect(
      openFor(service({ dataDir: longData, fallbackDirs: [path.join(root, "w".repeat(120))] }), r2),
    ).rejects.toThrow(ChannelOpenError);
    expect(types(r2.runId)).not.toContain(GIT_CHANNEL_OPENED);
  });

  it("refuses a second channel for the same run and an invalid run id", async () => {
    const r = await running();
    const s = service();
    await openFor(s, r);
    await expect(openFor(s, r)).rejects.toThrow(/already has a tool channel/u);
    await expect(openFor(s, { ...r, runId: "../../etc" })).rejects.toThrow(/invalid run id/u);
  });
});

describe("per-call checks (FR-GIT-02; stale, foreign, malformed calls refused with no side effect)", () => {
  it("commits with the right token, and the second identical call finds nothing to commit", async () => {
    const r = await running();
    writeFileSync(path.join(r.wt, "b.txt"), "b\n");
    const ch = await openFor(service(), r);
    const ans = await raw(ch.socketPath, req(tokenOf(ch), { message: "Add b", paths: ["b.txt"] }));
    expect(ans).toMatchObject({ ok: true, result: { files_changed: 1 } });
    expect(refSha(repo, publishRefFor(r.sessionId))).toBe(ans.result.sha);
    expect(await raw(ch.socketPath, req(tokenOf(ch), { message: "Again", paths: ["b.txt"] }))).toMatchObject({
      ok: false,
      error: { code: "NOTHING_TO_COMMIT" },
    });
  });

  it("refuses a wrong token, another run's token and a token-shaped forgery, recording only the code", async () => {
    const a = await running();
    const b = await running();
    writeFileSync(path.join(a.wt, "b.txt"), "b\n");
    const s = service();
    const chA = await openFor(s, a);
    const chB = await openFor(s, b);
    const forged = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    for (const token of [tokenOf(chB), forged, "", "x".repeat(300), tokenOf(chA).slice(0, -1)]) {
      const ans = await raw(chA.socketPath, req(token));
      expect(ans).toMatchObject({ ok: false });
      expect(["TOKEN_INVALID", "MALFORMED_REQUEST"]).toContain(ans.error.code);
    }
    expect(refSha(repo, publishRefFor(a.sessionId))).toBe("");
    expect(types(a.runId)).not.toContain("git_commit_intent");
    const events = JSON.stringify(ledger.listRunEvents(a.runId));
    expect(events).not.toContain(tokenOf(chB).slice(TOKEN_PREFIX.length));
    expect(events).not.toContain(forged.slice(TOKEN_PREFIX.length));
    expect(denied(a.runId).map((d) => d.code)).toEqual([
      "TOKEN_INVALID",
      "TOKEN_INVALID",
      "TOKEN_INVALID",
      "MALFORMED_REQUEST",
      "TOKEN_INVALID",
    ]);
  });

  it("refuses calls while the run is not RUNNING, and when the run's binding changed", async () => {
    const r = await running();
    writeFileSync(path.join(r.wt, "b.txt"), "b\n");
    const ch = await openFor(service(), r);
    const run = ledger.getRunRecord(r.runId);
    ledger.casRunState({
      runId: r.runId,
      from: "RUNNING",
      to: "FINALIZING",
      expectedVersion: run?.version ?? 0,
      payload: { rule: "T12" },
    });
    expect(await raw(ch.socketPath, req(tokenOf(ch)))).toMatchObject({ ok: false, error: { code: "NOT_RUNNING" } });

    const r2 = await running();
    writeFileSync(path.join(r2.wt, "b.txt"), "b\n");
    const ch2 = await openFor(services[0] as GitToolService, r2);
    db.prepare("UPDATE run SET worktree_path = ? WHERE id = ?").run(path.join(root, "elsewhere"), r2.runId);
    expect(await raw(ch2.socketPath, req(tokenOf(ch2)))).toMatchObject({
      ok: false,
      error: { code: "BINDING_MISMATCH" },
    });
    for (const id of [r.runId, r2.runId]) {
      expect(types(id)).not.toContain("git_commit_intent");
    }
    expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
    expect(refSha(repo, publishRefFor(r2.sessionId))).toBe("");
  });

  it("refuses malformed, oversized, unterminated and slow requests", async () => {
    const r = await running();
    const ch = await openFor(service({ limits: { requestTimeoutMs: 300 } }), r);
    const t = tokenOf(ch);
    const malformed = [
      "not json\n",
      "[1,2]\n",
      "null\n",
      '{"v":1}\n',
      `${JSON.stringify({ v: 2, token: t, tool: "commit", arguments: { message: "m" } })}\n`,
      `${JSON.stringify({ v: 1, token: t, tool: "commit", arguments: { message: "m" }, extra: 1 })}\n`,
      `${JSON.stringify({ v: 1, token: t, tool: "commit", arguments: ["m"] })}\n`,
    ];
    for (const m of malformed) {
      expect(await raw(ch.socketPath, m), m).toMatchObject({ ok: false, error: { code: "MALFORMED_REQUEST" } });
    }
    // A `__proto__` key is an own property after JSON.parse: it is an unknown argument, never a prototype.
    const proto = `{"v":1,"token":${JSON.stringify(t)},"tool":"commit","arguments":{"__proto__":{"message":"m"}}}\n`;
    expect(await raw(ch.socketPath, proto)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    // No newline, then the client half-closes.
    expect(await raw(ch.socketPath, req(t).trimEnd(), { end: true })).toMatchObject({
      error: { code: "MALFORMED_REQUEST" },
    });
    // Over the size limit before any newline.
    expect(await raw(ch.socketPath, Buffer.alloc(MAX_REQUEST_BYTES + 10, 0x61))).toMatchObject({
      error: { code: "REQUEST_TOO_LARGE" },
    });
    // Connected but silent.
    expect(await raw(ch.socketPath, "")).toMatchObject({ error: { code: "REQUEST_TIMEOUT" } });
    expect(types(r.runId)).not.toContain("git_commit_intent");
  });

  it("validates arguments: message length, unknown keys, paths, unknown tools", async () => {
    const r = await running();
    mkdirSync(path.join(r.wt, "dir"));
    symlinkSync(root, path.join(r.wt, "link"));
    const ch = await openFor(service(), r);
    const t = tokenOf(ch);
    const cases: [Record<string, unknown>, string, string?][] = [
      [{ message: "x".repeat(8193) }, "MESSAGE_TOO_LONG"],
      [{ message: "" }, "INVALID_ARGUMENTS"],
      [{ message: 5 }, "INVALID_ARGUMENTS"],
      [{ message: "m", paths: [] }, "INVALID_ARGUMENTS"],
      [{ message: "m", paths: ["a.txt", 3] }, "INVALID_ARGUMENTS"],
      [{ message: "m", paths: Array.from({ length: 257 }, (_, i) => `f${i}`) }, "INVALID_ARGUMENTS"],
      [{ message: "m", paths: ["x".repeat(4097)] }, "INVALID_ARGUMENTS"],
      [{ message: "m", author: "evil <e@x>" }, "INVALID_ARGUMENTS"],
      [{ message: "m", paths: ["../escape.txt"] }, "PATH_OUTSIDE_WORKTREE"],
      [{ message: "m", paths: [path.join(root, "repo", "a.txt")] }, "PATH_OUTSIDE_WORKTREE"],
      [{ message: "m", paths: ["link/repo/a.txt"] }, "PATH_OUTSIDE_WORKTREE"],
      [{ message: "m", paths: [".git/config"] }, "PATH_REFUSED"],
      [{ message: "m", paths: ["dir/../../a.txt"] }, "PATH_OUTSIDE_WORKTREE"],
      [{ message: "m" }, "UNKNOWN_TOOL", "push"],
      [{ message: "m" }, "UNKNOWN_TOOL", "status"],
    ];
    for (const [args, code, tool] of cases) {
      const ans = await raw(ch.socketPath, req(t, args, tool));
      expect(ans, JSON.stringify(args).slice(0, 80)).toMatchObject({ ok: false, error: { code } });
    }
    expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
    expect(types(r.runId)).not.toContain("git_commit_intent");
    expect(g(repo, "status", "--porcelain")).toBe("");
  });

  it("rate-limits every request and caps the refusal events it writes", async () => {
    const r = await running();
    const ch = await openFor(service({ limits: { maxCallsPerMinute: 3, maxRefusalEvents: 2 } }), r);
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(await raw(ch.socketPath, "garbage\n"));
    expect(answers.map((a) => a.error?.code)).toEqual([
      "MALFORMED_REQUEST",
      "MALFORMED_REQUEST",
      "MALFORMED_REQUEST",
      "RATE_LIMITED",
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    // A valid call is rate-limited too.
    expect(await raw(ch.socketPath, req(tokenOf(ch)))).toMatchObject({ error: { code: "RATE_LIMITED" } });
    await ch.close();
    expect(denied(r.runId)).toHaveLength(2);
    const closed = ledger.listRunEvents(r.runId).find((e) => e.type === GIT_CHANNEL_CLOSED);
    expect(JSON.parse(closed?.payload_json ?? "{}")).toMatchObject({ calls: 7, refused: 7, refusals_not_recorded: 5 });
  });

  it("two concurrent commits: the second loses the compare-and-swap, retries on the new head, and both land", async () => {
    const r = await running();
    writeFileSync(path.join(r.wt, "b.txt"), "b\n");
    writeFileSync(path.join(r.wt, "c.txt"), "c\n");
    let arrived = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((res) => {
      release = res;
    });
    const s = service({
      publisher: {
        testHooks: {
          afterStep: async (step) => {
            if (step !== "commit_created" || arrived >= 2) return;
            arrived += 1;
            if (arrived === 2) release();
            await barrier;
          },
        },
      },
    });
    const ch = await openFor(s, r);
    const [x, y] = await Promise.all([
      raw(ch.socketPath, req(tokenOf(ch), { message: "Add b", paths: ["b.txt"] })),
      raw(ch.socketPath, req(tokenOf(ch), { message: "Add c", paths: ["c.txt"] })),
    ]);
    expect(x).toMatchObject({ ok: true });
    expect(y).toMatchObject({ ok: true });
    const head = refSha(repo, publishRefFor(r.sessionId));
    expect([x.result.sha, y.result.sha]).toContain(head);
    expect(g(repo, "rev-list", "--count", head, "--not", "main")).toBe("2");
    expect(g(repo, "ls-tree", "--name-only", head).split("\n").sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    const aborted = ledger
      .listRunEvents(r.runId)
      .filter((e) => e.type === "git_commit_aborted")
      .map((e) => JSON.parse(e.payload_json).reason);
    expect(aborted).toEqual(["publish_ref_moved"]);
    expect(ledger.listGitCommits(r.runId)).toHaveLength(2);
  });
});

describe("close, cancel and crash recovery", () => {
  it("close removes the socket and directory; later and half-open connections get nothing done", async () => {
    const r = await running();
    writeFileSync(path.join(r.wt, "b.txt"), "b\n");
    const ch = await openFor(service(), r);
    // A connection that is open before close but sends its request afterwards.
    const early = net.createConnection({ path: ch.socketPath });
    let lateBuf = "";
    early.on("data", (d) => {
      lateBuf += d.toString();
    });
    early.on("error", () => {});
    const earlyClosed = new Promise<void>((res) => early.once("close", () => res()));
    await new Promise<void>((res) => early.once("connect", () => res()));
    await ch.close();
    await ch.close(); // idempotent
    if (!early.destroyed) early.write(req(tokenOf(ch)));
    await earlyClosed;
    const lateAnswer = lateBuf;
    expect(lateAnswer).not.toContain('"ok":true');
    expect(existsSync(ch.socketPath)).toBe(false);
    expect(existsSync(path.dirname(ch.socketPath))).toBe(false);
    expect(await raw(ch.socketPath, req(tokenOf(ch)))).toEqual({ closed: true });
    const viaShim = await forward({ socketPath: ch.socketPath, token: tokenOf(ch) }, "commit", { message: "m" }, 2000);
    expect(viaShim).toMatchObject({ ok: false, error: { code: "CHANNEL_UNAVAILABLE" } });
    expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
    const closed = ledger.listRunEvents(r.runId).filter((e) => e.type === GIT_CHANNEL_CLOSED);
    expect(closed).toHaveLength(1);
    expect(JSON.parse(closed[0]?.payload_json ?? "{}")).toMatchObject({ removed: true });
  });

  it("a crash leaves a stale socket; the startup sweep removes it and records the close; unsafe paths are kept", async () => {
    const r = await running();
    // Simulate the dead daemon: a process listens on the run's socket path and is killed with SIGKILL.
    const dir = path.join(dataDir, "runs", r.runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sockPath = path.join(dir, "tools.sock");
    spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(sockPath)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    expect(lstatSync(sockPath).isSocket()).toBe(true);
    ledger.appendRunEvent({
      runId: r.runId,
      type: GIT_CHANNEL_OPENED,
      payload: { tools: ["commit"], socket_dir: dir },
    });
    // Unsafe records the sweep must not act on: a directory outside the expected places, and a symbolic link.
    const r2 = await running();
    const outside = path.join(root, "keep-me");
    mkdirSync(outside, { mode: 0o700 });
    ledger.appendRunEvent({ runId: r2.runId, type: GIT_CHANNEL_OPENED, payload: { socket_dir: outside } });
    const r3 = await running();
    const target = path.join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    mkdirSync(path.join(dataDir, "runs"), { recursive: true });
    symlinkSync(target, path.join(dataDir, "runs", r3.runId));
    ledger.appendRunEvent({
      runId: r3.runId,
      type: GIT_CHANNEL_OPENED,
      payload: { socket_dir: path.join(dataDir, "runs", r3.runId) },
    });

    // Fallback directories: removed only directly inside a configured fallback parent.
    const r4 = await running();
    const fb = path.join(root, "sb-git-abc123");
    mkdirSync(fb, { mode: 0o700 });
    ledger.appendRunEvent({ runId: r4.runId, type: GIT_CHANNEL_OPENED, payload: { socket_dir: fb, fallback: true } });
    const r5 = await running();
    const fbElsewhere = path.join(root, "other", "sb-git-zzz999");
    mkdirSync(fbElsewhere, { recursive: true, mode: 0o700 });
    ledger.appendRunEvent({ runId: r5.runId, type: GIT_CHANNEL_OPENED, payload: { socket_dir: fbElsewhere } });

    const report = await service({ fallbackDirs: [root] }).sweepStale();
    expect(report.cleaned).toEqual([r.runId, r4.runId]);
    expect([...report.skipped].sort()).toEqual([r2.runId, r3.runId, r5.runId].sort());
    expect(existsSync(fb)).toBe(false);
    expect(existsSync(fbElsewhere)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(target)).toBe(true);
    const closed = ledger.listRunEvents(r.runId).find((e) => e.type === GIT_CHANNEL_CLOSED);
    expect(JSON.parse(closed?.payload_json ?? "{}")).toEqual({ reason: "recovered", removed: true });
    // Idempotent: a second sweep finds nothing open.
    expect(await service().sweepStale()).toEqual({ cleaned: [], skipped: [] });
  });
});

describe("token hygiene and the shim's own checks", () => {
  it("the artifact redactor removes a leaked token", () => {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const out = defaultRedactor(Buffer.from(`env says ${token} here`)).toString();
    expect(out).not.toContain(token.slice(TOKEN_PREFIX.length));
    expect(out).toContain("[REDACTED]");
  });

  it("shimConfig needs an absolute short socket path and a token-shaped variable, and removes it from the environment", () => {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const env: Record<string, string | undefined> = { [TOOL_TOKEN_ENV]: token, PATH: "/bin" };
    expect(shimConfig(["--socket", "/run/x/tools.sock"], env)).toEqual({ socketPath: "/run/x/tools.sock", token });
    expect(env[TOOL_TOKEN_ENV]).toBeUndefined();
    expect(() => shimConfig(["--socket", "rel/tools.sock"], { [TOOL_TOKEN_ENV]: token })).toThrow();
    expect(() => shimConfig(["--socket", `/${"a".repeat(200)}`], { [TOOL_TOKEN_ENV]: token })).toThrow();
    expect(() => shimConfig(["--socket", "/x"], {})).toThrow(/missing or malformed/u);
    expect(() => shimConfig(["--socket", "/x"], { [TOOL_TOKEN_ENV]: "short" })).toThrow(/missing or malformed/u);
    expect(() => shimConfig([], { [TOOL_TOKEN_ENV]: token })).toThrow(/usage/u);
  });

  it("the shim module holds no Git logic: it imports only the protocol module from the controller", () => {
    const src = readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cli", "tool-shim.ts"),
      "utf8",
    );
    const imports = [...src.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]);
    expect(imports.filter((i) => i?.startsWith("."))).toEqual(["../git/tool-protocol.js"]);
    const proto = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "tool-protocol.ts"), "utf8");
    expect([...proto.matchAll(/^import /gmu)]).toHaveLength(0);
  });

  it("socket permissions: the data directory's runs/ is tightened even if it existed with wider access", async () => {
    mkdirSync(path.join(dataDir, "runs"), { recursive: true, mode: 0o755 });
    const r = await running();
    const ch = await openFor(service(), r);
    expect(statSync(path.join(dataDir, "runs")).mode & 0o777).toBe(0o700);
    await ch.close();
  });
});
