import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnv, groupAlive, type SupervisedRun, type SuperviseOptions, supervise } from "./supervisor.js";

const NODE = process.execPath;
const node = (script: string): string[] => [NODE, "-e", script];

const started: SupervisedRun[] = [];
const extraPids = new Set<number>();

function run(opts: Partial<SuperviseOptions> & { argv: readonly string[] }): SupervisedRun {
  const r = supervise({ envAllowlist: ["PATH"], killGraceMs: 300, ...opts });
  started.push(r);
  return r;
}

/**
 * Live = exists and is not a zombie (zombies are dead but may await reaping by a slow init). `/proc` on Linux; BSD `ps`
 * elsewhere (macOS, T4.10), so the kill checks below are evidence on both platforms and never pass vacuously.
 */
function alive(pid: number): boolean {
  try {
    let state: string;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    } else {
      state = execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" })
        .trim()
        .slice(0, 1);
      if (state === "") return false;
    }
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  // Safety net so a failing test never leaves orphans behind.
  for (const r of started.splice(0)) {
    if (r.pgid !== undefined) {
      try {
        process.kill(-r.pgid, "SIGKILL");
      } catch {}
    }
  }
  for (const pid of extraPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  extraPids.clear();
});

/** Parent that spawns a same-group grandchild, prints both pids as JSON, then idles. */
const PARENT_WITH_GRANDCHILD = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
console.log(JSON.stringify({ child: process.pid, grandchild: g.pid }));
setInterval(()=>{},1000);
`;

function trackPids() {
  const pids: { child?: number; grandchild?: number } = {};
  const onEvent = (v: unknown) => {
    Object.assign(pids, v);
    if (typeof pids.grandchild === "number") extraPids.add(pids.grandchild);
  };
  return { pids, onEvent };
}

describe("supervise", () => {
  it("captures stdout and stderr separately and reports a normal exit", async () => {
    const r = run({ argv: node('process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(3)') });
    const res = await r.result;
    expect(res.outcome).toBe("exited");
    expect(res.exitCode).toBe(3);
    expect(res.failureCode).toBeUndefined();
    expect(res.stdout.toString()).toBe("out\n");
    expect(res.stderr.toString()).toBe("err\n");
    expect(res.groupEmpty).toBe(true);
  });

  it("runs the child in its own process group and reports pid/pgid before output", async () => {
    let info: { pid: number; pgid: number } | undefined;
    const r = run({
      argv: node(
        "console.log(JSON.stringify({pgid: require('node:child_process').execSync('ps -o pgid= -p '+process.pid).toString().trim()}))",
      ),
      onSpawn: (i) => {
        info = i;
      },
      onEvent: () => {},
    });
    const res = await r.result;
    expect(info?.pid).toBe(r.pid);
    expect(info?.pgid).toBe(r.pid);
    expect(info?.pgid).not.toBe(process.pid);
    expect(JSON.parse(res.stdout.toString()).pgid).toBe(String(r.pid));
  });

  it("does not use a shell: metacharacters in argv are literal", async () => {
    const r = run({ argv: [NODE, "-e", "console.log(process.argv[1])", "$(echo hi); `x` | y"] });
    const res = await r.result;
    expect(res.stdout.toString().trim()).toBe("$(echo hi); `x` | y");
  });

  it("passes only allowlisted and adapter-declared environment variables", async () => {
    process.env.SWITCHBOARD_TEST_SECRET = "leak";
    process.env.SWITCHBOARD_TEST_ALLOWED = "ok";
    try {
      const r = run({
        argv: node("console.log(JSON.stringify(process.env))"),
        envAllowlist: ["PATH", "SWITCHBOARD_TEST_ALLOWED"],
        extraEnv: { ADAPTER_VAR: "x" },
      });
      const env = JSON.parse((await r.result).stdout.toString()) as Record<string, string>;
      expect(env.SWITCHBOARD_TEST_SECRET).toBeUndefined();
      expect(env.SWITCHBOARD_TEST_ALLOWED).toBe("ok");
      expect(env.ADAPTER_VAR).toBe("x");
      const allowed = new Set(["PATH", "SWITCHBOARD_TEST_ALLOWED", "ADAPTER_VAR"]);
      // Node/ICU may add nothing else, but tolerate runtime-injected vars only if starting with NODE_/LC_ (and macOS's own `__CF_USER_TEXT_ENCODING`, T4.10).
      for (const k of Object.keys(env))
        expect(allowed.has(k) || /^(NODE_|LC_|PWD$|SHLVL$|_$|__CF_USER_TEXT_ENCODING$)/.test(k)).toBe(true);
    } finally {
      delete process.env.SWITCHBOARD_TEST_SECRET;
      delete process.env.SWITCHBOARD_TEST_ALLOWED;
    }
  });

  it("buildEnv takes values from the supplied base environment", () => {
    expect(buildEnv({ envAllowlist: ["A", "MISSING"], baseEnv: { A: "1", B: "2" }, extraEnv: { C: "3" } })).toEqual({
      A: "1",
      C: "3",
    });
  });

  it("delivers stdin text and then closes stdin", async () => {
    const r = run({
      argv: node('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d.length))'),
      stdinText: "hello",
    });
    expect((await r.result).stdout.toString().trim()).toBe("5");
  });

  it("parses JSONL events delivered in several writes", async () => {
    const events: unknown[] = [];
    const r = run({
      argv: node("process.stdout.write('{\"a\":');setTimeout(()=>process.stdout.write('1}\\n{\"b\":2}\\n'),30)"),
      onEvent: (v) => events.push(v),
    });
    const res = await r.result;
    expect(res.outcome).toBe("exited");
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("cancel kills the child and grandchild (SIGTERM, no escalation needed)", async () => {
    const { pids, onEvent } = trackPids();
    const r = run({ argv: node(PARENT_WITH_GRANDCHILD), onEvent });
    await waitFor(() => pids.grandchild !== undefined);
    expect(alive(pids.child as number)).toBe(true);
    expect(alive(pids.grandchild as number)).toBe(true);
    await r.cancel();
    const res = await r.result;
    expect(res.outcome).toBe("cancelled");
    expect(res.failureCode).toBeUndefined();
    expect(res.escalatedToKill).toBe(false);
    expect(res.groupEmpty).toBe(true);
    expect(alive(pids.child as number)).toBe(false);
    expect(alive(pids.grandchild as number)).toBe(false);
    expect(groupAlive(r.pgid as number)).toBe(false);
  });

  it("escalates to SIGKILL after the grace period when SIGTERM is ignored", async () => {
    const grace = 300;
    const script = `
process.on("SIGTERM", () => { console.log(JSON.stringify({ got: "SIGTERM", at: Date.now() })); });
console.log(JSON.stringify({ ready: true }));
setInterval(()=>{},1000);`;
    const seen: Array<Record<string, unknown>> = [];
    const r = run({
      argv: node(script),
      killGraceMs: grace,
      onEvent: (v) => seen.push(v as Record<string, unknown>),
    });
    await waitFor(() => seen.some((e) => e.ready === true));
    const t0 = Date.now();
    await r.cancel();
    const res = await r.result;
    const elapsed = Date.now() - t0;
    expect(seen.some((e) => e.got === "SIGTERM")).toBe(true);
    expect(res.escalatedToKill).toBe(true);
    expect(res.signal).toBe("SIGKILL");
    expect(res.outcome).toBe("cancelled");
    expect(elapsed).toBeGreaterThanOrEqual(grace - 20);
    expect(res.groupEmpty).toBe(true);
  });

  it("kills a grandchild that ignores SIGTERM even when the parent exits promptly", async () => {
    const script = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
console.log(JSON.stringify({ child: process.pid, grandchild: g.pid }));
setInterval(()=>{},1000);`;
    const { pids, onEvent } = trackPids();
    const r = run({ argv: node(script), onEvent, killGraceMs: 200 });
    await waitFor(() => pids.grandchild !== undefined);
    // Give the grandchild time to install its SIGTERM handler.
    await new Promise((res) => setTimeout(res, 150));
    await r.cancel();
    const res = await r.result;
    expect(res.escalatedToKill).toBe(true);
    expect(alive(pids.grandchild as number)).toBe(false);
    expect(res.groupEmpty).toBe(true);
  });

  it("wall-clock timeout kills the whole tree and reports PROCESS_TIMEOUT", async () => {
    const { pids, onEvent } = trackPids();
    const r = run({ argv: node(PARENT_WITH_GRANDCHILD), onEvent, wallClockMs: 400 });
    const res = await r.result;
    expect(res.outcome).toBe("timeout");
    expect(res.failureCode).toBe("PROCESS_TIMEOUT");
    expect(res.timeoutKind).toBe("wall_clock");
    expect(alive(pids.child as number)).toBe(false);
    expect(alive(pids.grandchild as number)).toBe(false);
    expect(res.groupEmpty).toBe(true);
  });

  it("idle timeout fires when stdout is silent and is reset by output", async () => {
    const script = `
let n = 0;
const t = setInterval(() => { console.log(JSON.stringify({ n: ++n })); if (n === 4) { clearInterval(t); setInterval(()=>{},1000); } }, 80);`;
    const events: unknown[] = [];
    const r = run({ argv: node(script), idleMs: 300, onEvent: (v) => events.push(v) });
    const res = await r.result;
    expect(events).toHaveLength(4); // survived 320ms of total runtime > idleMs because output reset the timer
    expect(res.outcome).toBe("timeout");
    expect(res.timeoutKind).toBe("idle");
    expect(res.failureCode).toBe("PROCESS_TIMEOUT");
  });

  it("oversize line yields OUTPUT_PROTOCOL_ERROR, kills the tree and keeps captured data", async () => {
    const script = `
console.log(JSON.stringify({ ok: 1 }));
process.stdout.write("x".repeat(5000));
setInterval(()=>{},1000);`;
    const events: unknown[] = [];
    const r = run({ argv: node(script), maxLineBytes: 1024, onEvent: (v) => events.push(v) });
    const res = await r.result;
    expect(res.outcome).toBe("protocol_error");
    expect(res.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(res.protocolError?.kind).toBe("line_too_long");
    expect(events).toEqual([{ ok: 1 }]);
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.groupEmpty).toBe(true);
  });

  it("malformed JSON yields OUTPUT_PROTOCOL_ERROR and the supervisor keeps working", async () => {
    const bad = run({
      argv: node('console.log("not json");setInterval(()=>{},1000)'),
      onEvent: () => {},
    });
    const res = await bad.result;
    expect(res.outcome).toBe("protocol_error");
    expect(res.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(res.protocolError?.kind).toBe("invalid_json");
    // A second, independent run is unaffected (NFR-REL-02).
    const good = run({ argv: node("console.log(1)") });
    expect((await good.result).outcome).toBe("exited");
  });

  it("contains an exception thrown by onEvent and kills the child", async () => {
    const r = run({
      argv: node('console.log("{}");setInterval(()=>{},1000)'),
      onEvent: () => {
        throw new Error("boom");
      },
    });
    const res = await r.result;
    expect(res.outcome).toBe("internal_error");
    expect(res.error?.message).toBe("boom");
    expect(res.groupEmpty).toBe(true);
  });

  it("reports a signal death not caused by the supervisor as PROCESS_CRASH", async () => {
    const res = await run({ argv: node('process.kill(process.pid, "SIGABRT")') }).result;
    expect(res.outcome).toBe("crashed");
    expect(res.failureCode).toBe("PROCESS_CRASH");
    expect(res.signal).toBe("SIGABRT");
  });

  it("reports spawn failure without throwing", async () => {
    const res = await run({ argv: ["/nonexistent/switchboard-binary"] }).result;
    expect(res.outcome).toBe("spawn_error");
    expect(res.error).toBeDefined();
  });

  it("cleans up a grandchild left behind after the child exits on its own", async () => {
    const script = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
console.log(JSON.stringify({ grandchild: g.pid }));
setTimeout(() => process.exit(0), 100);`;
    const { pids, onEvent } = trackPids();
    const res = await run({ argv: node(script), onEvent }).result;
    expect(res.outcome).toBe("exited");
    expect(alive(pids.grandchild as number)).toBe(false);
    expect(res.groupEmpty).toBe(true);
  });

  it("cancel after completion is a no-op", async () => {
    const r = run({ argv: node("1") });
    const res = await r.result;
    await r.cancel();
    expect(res.outcome).toBe("exited");
  });

  it("caps capture per stream and flags truncation while the run continues", async () => {
    const r = run({
      argv: node('process.stdout.write("a".repeat(1000));process.stderr.write("b".repeat(10))'),
      maxCaptureBytes: 100,
    });
    const res = await r.result;
    expect(res.outcome).toBe("exited");
    expect(res.stdout.length).toBe(100);
    expect(res.stdoutTruncated).toBe(true);
    expect(res.stderrTruncated).toBe(false);
  });
});

describe("supervise: acp-stdio primitives (T4.8)", () => {
  it("complete() closes stdin, waits the grace, kills the group, and reports exited", async () => {
    const r = run({
      argv: node('process.on("SIGTERM",()=>{});process.stdin.resume();setInterval(()=>{},1000)'),
      keepStdinOpen: true,
    });
    expect(r.writeStdin("hello\n")).toBe(true);
    await r.complete();
    const res = await r.result;
    expect(res.outcome).toBe("exited");
    expect(res.failureCode).toBeUndefined();
    expect(res.escalatedToKill).toBe(true);
    expect(res.groupEmpty).toBe(true);
    expect(r.writeStdin("late\n")).toBe(false);
  });

  it("fail() ends a run as a protocol error or a named timeout", async () => {
    const a = run({ argv: node("setInterval(()=>{},1000)") });
    a.fail({ kind: "protocol_error", error: { kind: "unknown_response_id", lineNumber: 3, message: "x" } });
    expect((await a.result).protocolError?.kind).toBe("unknown_response_id");
    const b = run({ argv: node("setInterval(()=>{},1000)") });
    b.fail({ kind: "timeout", timeoutKind: "acp_initialize" });
    const rb = await b.result;
    expect(rb.failureCode).toBe("PROCESS_TIMEOUT");
    expect(rb.timeoutKind).toBe("acp_initialize");
  });

  it("beforeTerminate runs on cancel, bounded by the grace period", async () => {
    let called: string | undefined;
    const r = run({
      argv: node("setInterval(()=>{},1000)"),
      beforeTerminate: (why) => {
        called = why;
        return new Promise(() => {}); // never settles: the supervisor must not wait on it
      },
    });
    const t0 = Date.now();
    await r.cancel();
    const res = await r.result;
    expect(called).toBe("cancelled");
    expect(res.outcome).toBe("cancelled");
    expect(res.groupEmpty).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
