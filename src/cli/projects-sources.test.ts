/**
 * `projects sources list|approve|reject` (ADR-0079 item 8). The ledger is written through the same store the MCP tool
 * uses; no provider CLI.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { openLedger } from "../ledger/index.js";
import { LOCK_FILE_NAME } from "../lock/index.js";
import { ProjectSourceGrantStore } from "../projects/index.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-prj-src-")));
  mkdirSync(path.join(tmp, "roots", "clones"), { recursive: true });
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(tmp, "roots")],
      mcp_clients: [{ id: "mgr", max_trust_profile: "edit-untrusted", manage_projects: true }],
      project_sources: { clone_root: path.join(tmp, "roots", "clones"), allowed_owners: ["acme"] },
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "operator1",
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** Writes requests as the MCP tool would (it shares this store). */
function seed(...owners: string[]): string[] {
  const db = openLedger(dataDir);
  try {
    const store = new ProjectSourceGrantStore(db, {
      ids: createIdGenerator(),
      config: { cloneRoot: "/x", allowedHosts: ["github.com"], allowedOwners: ["acme"] },
    });
    return owners.map((owner) => store.request({ clientId: "mgr", host: "github.com", owner }).id);
  } finally {
    db.close();
  }
}

function rows(): { request_id: string; decision: string; decided_by: string }[] {
  const db = openLedger(dataDir);
  try {
    return db.prepare("SELECT request_id, decision, decided_by FROM project_source_decision").all() as {
      request_id: string;
      decision: string;
      decided_by: string;
    }[];
  } finally {
    db.close();
  }
}

describe("projects sources", () => {
  it("lists requests with their status; no ledger means none", async () => {
    const empty = await run(["projects", "sources", "list", "--json"]);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.out).requests).toEqual([]);
    const [id] = seed("newco");
    const list = await run(["projects", "sources", "list", "--json"]);
    expect(JSON.parse(list.out).requests).toEqual([
      expect.objectContaining({ id, client_id: "mgr", host: "github.com", owner: "newco", status: "PENDING" }),
    ]);
    expect((await run(["projects", "sources", "list"])).out).toContain(`${id}\tpending\tnewco on github.com`);
  });

  it("approves and rejects a request, recording the operator", async () => {
    const [a, b] = seed("newco", "other");
    const approved = await run(["projects", "sources", "approve", a as string, "--json"]);
    expect(approved.code).toBe(0);
    expect(JSON.parse(approved.out)).toMatchObject({
      request_id: a,
      owner: "newco",
      decision: "approved",
      decided_by: "operator1",
      daemon_running: false,
    });
    const rejected = await run(["projects", "sources", "reject", b as string, "--json"]);
    expect(JSON.parse(rejected.out)).toMatchObject({ decision: "rejected" });
    expect(rows()).toEqual([
      { request_id: a, decision: "APPROVED", decided_by: "operator1" },
      { request_id: b, decision: "REJECTED", decided_by: "operator1" },
    ]);
    expect((await run(["projects", "sources", "approve", a as string])).out).toBe("");
  });

  it("refuses an unknown or already decided request and bad usage", async () => {
    const [a] = seed("newco");
    expect((await run(["projects", "sources", "approve", a as string])).code).toBe(0);
    const again = await run(["projects", "sources", "reject", a as string, "--json"]);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.out).error.code).toBe("REFUSED");
    const unknown = await run(["projects", "sources", "approve", "psr_nope", "--json"]);
    expect(unknown.code).toBe(1);
    expect((await run(["projects", "sources", "approve"])).code).toBe(2);
    expect((await run(["projects", "sources", "bogus"])).code).toBe(2);
    expect((await run(["projects", "sources", "list", "extra"])).code).toBe(2);
  });

  it("writes the decision while a serve daemon holds the lock", async () => {
    const [a] = seed("newco");
    writeFileSync(path.join(dataDir, LOCK_FILE_NAME), `${process.pid}\n`); // a live owner
    const r = await run(["projects", "sources", "approve", a as string, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ decision: "approved", daemon_running: true });
  });
});
