/**
 * `switchboard pause` / `switchboard resume` (T14.6; FR-CTL-05, FR-OPS-01, LLD §3.4.4). The ROADMAP done-when: the CLI
 * pause is global, and its effect on a running `serve` is the operator-poll application (the daemon side is
 * `applyPauseRequests`, exercised here with the lock held as a daemon would; the spawned-daemon case is in
 * `serve.test.ts`). `main` is called in process with injected streams; no provider CLI.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPauseRequests, GLOBAL_PAUSE_SCOPE } from "../control/pause.js";
import { createLedger, LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import { HELP, main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cli-pause-")));
  const repos = path.join(tmp, "repos");
  mkdirSync(repos);
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [repos],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
    ...extra,
  };
  const code = await main(args, io);
  return { code, out: out.join(""), err: err.join("") };
}
const cfg = () => ["--config", configPath];

function withLedger<T>(fn: (ledger: ReturnType<typeof createLedger>) => T): T {
  const db = openLedger(dataDir);
  try {
    return fn(createLedger(db));
  } finally {
    db.close();
  }
}
const globalRow = () => withLedger((l) => l.getControlPlaneState(GLOBAL_PAUSE_SCOPE));
const eventTypes = () => withLedger((l) => l.listControlPlaneEvents(GLOBAL_PAUSE_SCOPE).map((e) => e.type));

describe("pause / resume (T14.6, FR-CTL-05, FR-OPS-01)", () => {
  it("are top-level operator commands in the help, take no arguments, and are not MCP tools", async () => {
    expect(HELP).toMatch(/^ {2}pause {15}Pause every project/mu);
    expect(HELP).toMatch(/^ {2}resume {14}Lift the operator pause/mu);
    expect(HELP).toContain("an MCP client can pause only its own projects");
    expect((await run(["pause", "web", ...cfg()])).code).toBe(2);
    expect((await run(["resume", "--json", "x", ...cfg()])).code).toBe(2);
    expect(globalRow()).toBeUndefined();
  });

  it("without a daemon: pause is applied at once to every project, with a stable --json schema; resume lifts it", async () => {
    const paused = await run(["pause", "--json", ...cfg()]);
    expect(paused.code).toBe(0);
    const j = JSON.parse(paused.out);
    expect(Object.keys(j)).toEqual([
      "schema_version",
      "command",
      "scope",
      "outcome",
      "paused",
      "daemon_running",
      "request_event_id",
      "requested_by",
      "requested_at",
    ]);
    expect(j).toMatchObject({
      schema_version: 1,
      command: "pause",
      scope: "*",
      outcome: "applied",
      paused: true,
      daemon_running: false,
      requested_by: "tester",
    });
    expect(j.request_event_id).toMatch(/^cpe_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(globalRow()).toMatchObject({ project_id: "*", paused: 1, paused_by: "tester" });
    expect(eventTypes()).toEqual(["operator_pause_requested", "operator_pause_applied"]);
    expect(withLedger((l) => l.listPendingPauseRequests())).toEqual([]);

    const text = await run(["resume", ...cfg()]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("all projects resumed (no daemon was running; applied directly)");
    expect(text.out).toContain("requested by tester");
    expect(globalRow()).toMatchObject({ paused: 0, paused_by: "tester" });
    expect(eventTypes()).toEqual([
      "operator_pause_requested",
      "operator_pause_applied",
      "operator_resume_requested",
      "operator_pause_applied",
    ]);
  });

  it("before any serve ran: pause creates the ledger so the first daemon starts paused", async () => {
    expect(existsSync(path.join(dataDir, LEDGER_FILE_NAME))).toBe(false);
    const r = await run(["pause", ...cfg()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("all projects paused");
    expect(globalRow()).toMatchObject({ paused: 1 });
  });

  it("with a daemon holding the lock: only the request is recorded; the daemon applies it on its poll, once", async () => {
    withLedger(() => undefined); // the daemon created the ledger
    const lock = acquireDataDirLock(dataDir);
    let requestEventId: string;
    try {
      const j = JSON.parse((await run(["pause", "--json", ...cfg()])).out);
      expect(j).toMatchObject({ outcome: "requested", paused: false, daemon_running: true, requested_by: "tester" });
      requestEventId = j.request_event_id;
      expect(globalRow()).toBeUndefined();
      expect(eventTypes()).toEqual(["operator_pause_requested"]);
      const text = await run(["pause", ...cfg()]);
      expect(text.out).toContain("the serve daemon will apply it on its next operator poll");
      expect(text.out).toContain("paused now: false");
    } finally {
      lock.release();
    }
    const applied = withLedger((l) => applyPauseRequests(l));
    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ requestEventId, scope: "*", paused: true, requestedBy: "tester" });
    expect(globalRow()).toMatchObject({ paused: 1, paused_by: "tester" });
    expect(withLedger((l) => applyPauseRequests(l))).toEqual([]);
    expect(eventTypes()).toEqual([
      "operator_pause_requested",
      "operator_pause_requested",
      "operator_pause_applied",
      "operator_pause_applied",
    ]);
    // A later resume under the same daemon: recorded, applied by the next poll, and the row says who resumed.
    const lock2 = acquireDataDirLock(dataDir);
    try {
      expect(JSON.parse((await run(["resume", "--json", ...cfg()])).out)).toMatchObject({
        command: "resume",
        outcome: "requested",
        paused: true,
      });
      expect(globalRow()).toMatchObject({ paused: 1 });
    } finally {
      lock2.release();
    }
    expect(withLedger((l) => applyPauseRequests(l))).toMatchObject([{ paused: false }]);
    expect(globalRow()).toMatchObject({ paused: 0, paused_by: "tester" });
  });

  it("reports a usage error on an unknown flag and an invalid config as the other commands do", async () => {
    expect((await run(["pause", "--bogus", ...cfg()])).code).toBe(2);
    writeFileSync(configPath, "{");
    const bad = await run(["pause", "--json", ...cfg()]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).error).toBeDefined();
  });
});
