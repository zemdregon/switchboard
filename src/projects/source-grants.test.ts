/** ADR-0079 item 8: runtime grants of `project_sources.allowed_owners` (store and live settings). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectSourcesSettings } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { openLedger } from "../ledger/index.js";
import { sourceAllowed } from "./clone.js";
import { effectiveProjectSources, ProjectSourceError, ProjectSourceGrantStore } from "./source-grants.js";

const CONFIG: ProjectSourcesSettings = {
  cloneRoot: "/tmp/clones",
  allowedHosts: ["github.com"],
  allowedOwners: ["acme"],
};

let dir: string;
let db: Database.Database;
let store: ProjectSourceGrantStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-grants-"));
  db = openLedger(dir);
  store = new ProjectSourceGrantStore(db, { ids: createIdGenerator(), config: CONFIG });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProjectSourceError) return err.reason;
    throw err;
  }
  return undefined;
};

describe("ProjectSourceGrantStore", () => {
  it("stores a request with a lower-case owner and psr_ id, pending", () => {
    const r = store.request({ clientId: "c1", host: "github.com", owner: "NewCo" });
    expect(r).toMatchObject({ client_id: "c1", host: "github.com", owner: "newco", status: "PENDING" });
    expect(r.id).toMatch(/^psr_/);
    expect(store.pending().map((p) => p.id)).toEqual([r.id]);
    expect(store.get(r.id)).toMatchObject({ status: "PENDING" });
  });

  it("refuses with closed reasons", () => {
    expect(reason(() => store.request({ clientId: "c", host: "gitlab.com", owner: "x" }))).toBe("HOST_NOT_ALLOWED");
    for (const owner of ["", ".", "..", "a/b", "a b", "-x", "x".repeat(101)]) {
      expect(
        reason(() => store.request({ clientId: "c", host: "github.com", owner })),
        owner,
      ).toBe("OWNER_INVALID");
    }
    expect(reason(() => store.request({ clientId: "c", host: "github.com", owner: "ACME" }))).toBe(
      "OWNER_ALREADY_ALLOWED",
    );
    const bare = new ProjectSourceGrantStore(db, {});
    expect(reason(() => bare.request({ clientId: "c", host: "github.com", owner: "x" }))).toBe("NOT_CONFIGURED");
  });

  it("is idempotent for pending and approved requests, and allows a new one after a rejection", () => {
    const a = store.request({ clientId: "c1", host: "github.com", owner: "newco" });
    expect(store.request({ clientId: "c2", host: "github.com", owner: "NEWCO" }).id).toBe(a.id);
    store.decide({ requestId: a.id, decision: "APPROVED", decidedBy: "op" });
    expect(store.request({ clientId: "c1", host: "github.com", owner: "newco" })).toMatchObject({
      id: a.id,
      status: "APPROVED",
    });
    const b = store.request({ clientId: "c1", host: "github.com", owner: "other" });
    store.decide({ requestId: b.id, decision: "REJECTED", decidedBy: "op" });
    const c = store.request({ clientId: "c1", host: "github.com", owner: "other" });
    expect(c.id).not.toBe(b.id);
    expect(c.status).toBe("PENDING");
  });

  it("decides once", () => {
    const r = store.request({ clientId: "c1", host: "github.com", owner: "newco" });
    const d = store.decide({ requestId: r.id, decision: "APPROVED", decidedBy: "mcp_proxy:a" });
    expect(d).toMatchObject({ status: "APPROVED", decided_by: "mcp_proxy:a" });
    expect(reason(() => store.decide({ requestId: r.id, decision: "REJECTED", decidedBy: "op" }))).toBe(
      "ALREADY_DECIDED",
    );
    expect(reason(() => store.decide({ requestId: "psr_nope", decision: "REJECTED", decidedBy: "op" }))).toBe(
      "UNKNOWN_REQUEST",
    );
    expect(store.pending()).toEqual([]);
    expect(store.get(r.id)?.status).toBe("APPROVED");
    const row = db.prepare("SELECT id FROM project_source_decision").get() as { id: string };
    expect(row.id).toMatch(/^psd_/);
  });

  it("approvedOwners lists only approved owners, optionally per host", () => {
    const a = store.request({ clientId: "c", host: "github.com", owner: "one" });
    const b = store.request({ clientId: "c", host: "github.com", owner: "two" });
    store.request({ clientId: "c", host: "github.com", owner: "three" });
    store.decide({ requestId: a.id, decision: "APPROVED", decidedBy: "op" });
    store.decide({ requestId: b.id, decision: "REJECTED", decidedBy: "op" });
    expect(store.approvedOwners()).toEqual(["one"]);
    expect(store.approvedOwners("github.com")).toEqual(["one"]);
    expect(store.approvedOwners("gitlab.com")).toEqual([]);
  });
});

describe("effectiveProjectSources", () => {
  it("adds approved owners at the next call and never a host", () => {
    const get = effectiveProjectSources(CONFIG, store);
    const src = { host: "github.com", owner: "NewCo", repo: "r" };
    expect(sourceAllowed(src, get() as ProjectSourcesSettings)).toBe(false);
    const r = store.request({ clientId: "c", host: "github.com", owner: "newco" });
    expect(sourceAllowed(src, get() as ProjectSourcesSettings)).toBe(false);
    store.decide({ requestId: r.id, decision: "APPROVED", decidedBy: "op" });
    const live = get() as ProjectSourcesSettings;
    expect(sourceAllowed(src, live)).toBe(true);
    expect(live.allowedOwners).toEqual(["acme", "newco"]);
    expect(live.allowedHosts).toEqual(["github.com"]);
    expect(sourceAllowed({ ...src, host: "gitlab.com" }, live)).toBe(false);
  });

  it("stays absent without project_sources", () => {
    expect(effectiveProjectSources(undefined, store)()).toBeUndefined();
  });
});
