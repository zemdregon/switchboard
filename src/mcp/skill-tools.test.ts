/**
 * T16.9 (FR-SKL-08, FR-CTL-11, LLD §19.9, ADR-0056 item 12): `list_skills` and `get_skill` through the SDK client on
 * the routing harness (fake providers only; no provider CLI is installed or called). The T16.1 store is filled with the
 * operator helpers (`addSkill`, `appendSkillEvent`), the way `switchboard skills` (T16.2) will.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedSkills } from "../config/index.js";
import type { TrustProfile } from "../ledger/index.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import { BODY_CANARY, source } from "../skills/fixtures/sources.js";
import {
  addSkill,
  appendSkillEvent,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
  resolveSkills,
  storeCatalog,
} from "../skills/index.js";
import { SKILL_TOOL_NAMES, toolDescriptors } from "./schemas.js";

const edit: TrustProfile = "edit-untrusted";
const trusted: TrustProfile = "trusted-development";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function settings(over: Partial<ResolvedSkills> = {}): ResolvedSkills {
  return {
    enabled: true,
    defaults: [],
    roles: {},
    delivery: "native_preferred",
    allowDraftInTrusted: false,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxPerRun: DEFAULT_MAX_PER_RUN,
    maxRunBytes: DEFAULT_MAX_RUN_BYTES,
    maxNames: DEFAULT_MAX_NAMES,
    ...over,
  };
}

/** A configured project as `searchTarget` reads it; only `id`, the ceiling and `skills` matter here. */
const project = (id: string, skills?: Pick<ResolvedSkills, "defaults" | "roles">) => ({
  id,
  name: id,
  environment: { kind: "host" },
  contexts: [],
  ...(skills !== undefined ? { skills } : {}),
});

interface Setup {
  skills?: ResolvedSkills | "absent";
  orch?: Record<string, unknown>;
  other?: Record<string, unknown>;
  projects?: object[];
}

async function start(s: Setup = {}): Promise<Harness> {
  h = await startHarness({
    config: {
      mcpClients: new Map([
        ["orch", { id: "orch", maxTrustProfile: edit, projects: ["app"], ...s.orch }],
        ["other", { id: "other", maxTrustProfile: edit, toolProfile: "console" as const, ...s.other }],
      ]),
      projects: s.projects ?? [],
    },
    deps: ({ db, dataDir }) =>
      s.skills === "absent" ? {} : { skills: { db, dataDir, settings: s.skills ?? settings() } },
  });
  return h;
}

const dataDir = (x: Harness) => path.join(x.root, "data");

/** Store one version of `name` (operator file, or `repository_path` when `repo`) and return its version number. */
function add(x: Harness, name: string, body: string, opts: { repo?: boolean; description?: string } = {}): number {
  const dir = path.join(x.root, opts.repo ? "skill-repo" : "operator");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(
    file,
    source(`${body}\n`, { name, ...(opts.description !== undefined ? { description: opts.description } : {}) }),
  );
  const r = addSkill(
    x.db,
    dataDir(x),
    { name, file, ...(opts.repo ? { fromRepository: true } : {}) },
    { repositoryRoots: opts.repo ? [dir] : [] },
  );
  if (r.kind !== "added") throw new Error(`add ${name}: ${JSON.stringify(r)}`);
  return r.version;
}
const approve = (x: Harness, name: string, version: number) =>
  appendSkillEvent(x.db, { name, version, kind: "approved" });

/** Every row of every table, so "writes nothing" covers tables this test does not know about. */
function ledgerDump(db: Database.Database): string {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
  ).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
}

const toolNames = async (x: Harness, clientId: string) =>
  (await x.client(clientId).listTools()).tools.map((t) => t.name);

type SkillRow = { name: string; version: number; approved: boolean; origin: string };

describe("offering (FR-SKL-08, FR-CTL-11)", () => {
  it("with skills.enabled false the tool list is byte-identical to a server without skill support", async () => {
    const plain = await start({ skills: "absent" });
    const before = {
      orch: JSON.stringify(await plain.client("orch").listTools()),
      other: JSON.stringify(await plain.client("other").listTools()),
    };
    await plain.close();
    h = undefined;
    const off = await start({ skills: settings({ enabled: false }) });
    expect(JSON.stringify(await off.client("orch").listTools())).toBe(before.orch);
    expect(JSON.stringify(await off.client("other").listTools())).toBe(before.other);
    expect(toolDescriptors({ skills: false })).toEqual(toolDescriptors());
    for (const tool of SKILL_TOOL_NAMES) {
      const r = await off.call(tool, { name: "alpha" });
      expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: `unknown tool "${tool}"` });
    }
  });

  it("an enabled installation offers both tools to an orchestrator client and never to a console client", async () => {
    const x = await start({ other: { toolProfile: "console" } });
    expect(await toolNames(x, "orch")).toEqual(expect.arrayContaining([...SKILL_TOOL_NAMES]));
    const consoleNames = await toolNames(x, "other");
    for (const tool of SKILL_TOOL_NAMES) {
      expect(consoleNames).not.toContain(tool);
      const r = await x.call(tool, { name: "alpha" }, "other");
      expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: `unknown tool "${tool}"` });
    }
  });

  it("an explicit orchestrator profile sees the same tools as the default", async () => {
    const x = await start({ other: { toolProfile: "orchestrator" } });
    expect(await toolNames(x, "other")).toEqual(await toolNames(x, "orch"));
  });
});

describe("visibility (mcp_clients[].skills)", () => {
  it("an invisible name is absent from list_skills and get_skill on it is the same INVALID_REQUEST as an unknown name", async () => {
    const x = await start({ orch: { skills: ["alpha", "beta"] } });
    for (const n of ["alpha", "beta", "gamma"]) approve(x, n, add(x, n, `${n} body ${BODY_CANARY}`));
    const list = await x.ok("list_skills", {});
    expect((list.skills as SkillRow[]).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(list).not.toHaveProperty("defaults");
    expect(JSON.stringify(list)).not.toContain(BODY_CANARY); // no body in list_skills

    const invisible = await x.call("get_skill", { name: "gamma" });
    const unknown = await x.call("get_skill", { name: "no-such-skill" });
    expect(invisible.isError).toBe(true);
    expect(invisible.body).toEqual(unknown.body);
    expect(unknown.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(JSON.stringify(unknown.body)).not.toContain("no-such-skill");

    const got = await x.ok("get_skill", { name: "alpha" });
    expect(got).toMatchObject({ name: "alpha", version: 1, approved: true, body: `alpha body ${BODY_CANARY}\n` });
  });

  it("an absent allow-list sees every approved name; an empty one sees none", async () => {
    const all = await start();
    for (const n of ["alpha", "beta"]) approve(all, n, add(all, n, n));
    add(all, "draft-only", "never approved");
    expect(((await all.ok("list_skills", {})).skills as SkillRow[]).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect((await all.call("get_skill", { name: "draft-only" })).body.error).toMatchObject({ code: "INVALID_REQUEST" });
    await all.close();
    h = undefined;

    const none = await start({ orch: { skills: [] } });
    approve(none, "alpha", add(none, "alpha", "a"));
    expect((await none.ok("list_skills", {})).skills).toEqual([]);
    expect((await none.call("get_skill", { name: "alpha" })).body.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("a retired name, a revoked version and a draft are not shown or returned", async () => {
    const x = await start();
    approve(x, "alpha", add(x, "alpha", "a1"));
    appendSkillEvent(x.db, { name: "alpha", kind: "retired" });
    const v1 = add(x, "beta", "b1");
    approve(x, "beta", v1);
    const v2 = add(x, "beta", "b2");
    approve(x, "beta", v2);
    appendSkillEvent(x.db, { name: "beta", version: v2, kind: "revoked" });
    const v3 = add(x, "beta", "b3"); // draft
    expect(await x.ok("list_skills", {})).toMatchObject({ skills: [{ name: "beta", version: v1, approved: true }] });
    const miss = (await x.call("get_skill", { name: "no-such-skill" })).body;
    for (const args of [{ name: "alpha" }, { name: "beta", version: v2 }, { name: "beta", version: v3 }]) {
      expect((await x.call("get_skill", args)).body, JSON.stringify(args)).toEqual(miss);
    }
    expect(await x.ok("get_skill", { name: "beta", version: v1 })).toMatchObject({ version: v1, body: "b1\n" });
  });
});

describe("trust_profile (LLD §19.5 step 4)", () => {
  it("returns per name the newest version the client could inject under trust_profile (default its maximum)", async () => {
    const x = await start({
      skills: settings({ allowDraftInTrusted: true }),
      orch: { maxTrustProfile: trusted },
    });
    const v1 = add(x, "beta", "b1");
    approve(x, "beta", v1);
    const v2 = add(x, "beta", "b2"); // draft: injectable only in a trusted profile with allow_draft_in_trusted
    approve(x, "repo-skill", add(x, "repo-skill", "from a repository", { repo: true }));

    const atMax = (await x.ok("list_skills", {})).skills as SkillRow[];
    expect(atMax).toEqual([
      expect.objectContaining({ name: "beta", version: v2, approved: false, origin: "operator_file" }),
      expect.objectContaining({ name: "repo-skill", version: 1, approved: true, origin: "repository_path" }),
    ]);
    const untrusted = (await x.ok("list_skills", { trust_profile: edit })).skills as SkillRow[];
    expect(untrusted).toEqual([expect.objectContaining({ name: "beta", version: v1, approved: true })]);
    expect(await x.ok("get_skill", { name: "beta" })).toMatchObject({ version: v2, approved: false, body: "b2\n" });

    const above = await x.call("list_skills", { trust_profile: "privileged" });
    expect(above.body.error).toMatchObject({ code: "PERMISSION_BLOCKED" });
  });

  it("without allow_draft_in_trusted a draft is never injectable", async () => {
    const x = await start({ orch: { maxTrustProfile: trusted } });
    const v1 = add(x, "beta", "b1");
    approve(x, "beta", v1);
    add(x, "beta", "b2");
    expect(await x.ok("list_skills", {})).toMatchObject({ skills: [{ name: "beta", version: v1 }] });
  });

  it("a repository-origin version is hidden under the client's untrusted maximum", async () => {
    const x = await start();
    approve(x, "repo-skill", add(x, "repo-skill", "r", { repo: true }));
    expect((await x.ok("list_skills", {})).skills).toEqual([]);
    expect((await x.call("get_skill", { name: "repo-skill" })).body.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("applies_to_providers is the stored list, or null for every provider", async () => {
    const x = await start();
    approve(x, "alpha", add(x, "alpha", "a"));
    const dir = path.join(x.root, "operator");
    const file = path.join(dir, "scoped.md");
    writeFileSync(file, source("s\n", { name: "scoped", applies_to_providers: "[codex, claude-code]" }));
    const r = addSkill(x.db, dataDir(x), { name: "scoped", file }, { repositoryRoots: [] });
    if (r.kind !== "added") throw new Error("add failed");
    approve(x, "scoped", r.version);
    expect(
      ((await x.ok("list_skills", {})).skills as Record<string, unknown>[]).map((s) => s.applies_to_providers),
    ).toEqual([null, ["codex", "claude-code"]]);
  });
});

describe("defaults (LLD §19.5 steps 2 to 4)", () => {
  const configured = settings({
    defaults: ["alpha"],
    roles: { reviewer: ["beta@1", "gamma", "alpha"] },
  });
  const app = project("app", {
    defaults: ["alpha", "missing-one", "delta"],
    roles: { reviewer: ["repo-skill", "beta"] },
  });

  it("defaults matches what admission resolves for the same project and role", async () => {
    const x = await start({
      skills: configured,
      orch: { skills: ["alpha", "beta", "delta", "repo-skill"] },
      projects: [app],
    });
    approve(x, "alpha", add(x, "alpha", "a"));
    approve(x, "beta", add(x, "beta", "b1"));
    approve(x, "beta", add(x, "beta", "b2"));
    approve(x, "gamma", add(x, "gamma", "g")); // outside the client's allow-list
    approve(x, "delta", add(x, "delta", "d"));
    approve(x, "repo-skill", add(x, "repo-skill", "r", { repo: true })); // repository origin, untrusted profile

    const out = await x.ok("list_skills", { project: "app", role: "reviewer" });
    // The resolver admission reuses (`resolveSkills`, src/skills/resolve.ts), on the same store and inputs.
    const admission = resolveSkills(
      {
        profile: edit,
        allowDraftInTrusted: false,
        clientSkills: ["alpha", "beta", "delta", "repo-skill"],
        global: configured,
        project: app.skills as never,
        role: "reviewer",
      },
      storeCatalog(x.db),
    );
    expect(out.defaults).toEqual(
      admission.entries.map((e) => ({ name: e.name, version: e.version, source: e.source })),
    );
    // Spelled out: alpha first (global default), beta pinned at 1 by its role entry, delta from the project.
    expect(out.defaults).toEqual([
      { name: "alpha", version: 1, source: "global_default" },
      { name: "beta", version: 1, source: "global_role" },
      { name: "delta", version: 1, source: "project_default" },
    ]);
    expect(admission.skipped.map((s) => [s.ref, s.reason])).toEqual([
      ["gamma", "SKILL_NOT_PERMITTED"],
      ["missing-one", "SKILL_UNKNOWN"],
      ["repo-skill", "SKILL_REPOSITORY_ORIGIN"],
    ]);

    // An unknown role selects nothing from the role lists; it is not an error.
    expect((await x.ok("list_skills", { project: "app", role: "nobody" })).defaults).toEqual([
      { name: "alpha", version: 1, source: "global_default" },
      { name: "delta", version: 1, source: "project_default" },
    ]);
  });

  it("a project this client may not use is reported like an unknown project", async () => {
    const x = await start({ skills: configured, projects: [app, project("secret")] });
    const notMine = await x.call("list_skills", { project: "secret" });
    const unknown = await x.call("list_skills", { project: "nowhere" });
    expect(notMine.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(unknown.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(notMine.body.error).toMatchObject({ details: { field: "project" } });
  });
});

describe("read-only (FR-SKL-08)", () => {
  it("neither tool writes a ledger row, on success or refusal", async () => {
    const x = await start({
      orch: { skills: ["alpha"] },
      skills: settings({ defaults: ["alpha"] }),
      projects: [project("app")],
    });
    approve(x, "alpha", add(x, "alpha", "a"));
    approve(x, "hidden", add(x, "hidden", "h"));
    const before = ledgerDump(x.db);
    await x.ok("list_skills", {});
    await x.ok("list_skills", { project: "app", role: "reviewer", trust_profile: edit });
    await x.ok("get_skill", { name: "alpha" });
    await x.ok("get_skill", { name: "alpha", version: 1 });
    expect((await x.call("get_skill", { name: "hidden" })).isError).toBe(true);
    expect((await x.call("list_skills", { trust_profile: "privileged" })).isError).toBe(true);
    expect((await x.call("get_skill", { name: "Bad Name" })).isError).toBe(true);
    expect(ledgerDump(x.db)).toBe(before);
  });

  it("a stored file that no longer matches its hash is TOOL_FAILURE, never altered text", async () => {
    const x = await start();
    approve(x, "alpha", add(x, "alpha", "a"));
    const sha = (x.db.prepare("SELECT sha256 FROM skill_version WHERE name = 'alpha'").get() as { sha256: string })
      .sha256;
    writeFileSync(path.join(dataDir(x), "skills", `${sha}.md`), "tampered\n");
    const r = await x.call("get_skill", { name: "alpha" });
    expect(r.body.error).toMatchObject({ code: "TOOL_FAILURE", details: { reason: "SKILL_CONTENT_UNAVAILABLE" } });
  });
});
