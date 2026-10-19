/**
 * Skills configuration (T16.3; FR-SKL-03, FR-SKL-04, FR-SKL-08, LLD §19.3, TDD §3.16.2 property 1).
 * Config fixtures only, plus one fake-adapter run. No provider CLI and no login.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import {
  type CompileRequest,
  type Ineligible,
  type Invocation,
  isIneligible,
  type ResolvedProfile,
} from "../adapters/types.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { MAX_MAX_BODY_BYTES, MAX_MAX_NAMES, MAX_MAX_PER_RUN, MAX_MAX_RUN_BYTES } from "../skills/limits.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  configSchema,
  configSchemaFor,
  loadConfig,
  PROVIDER_IDS,
  projectSchema,
  type ResolvedConfig,
  type ResolvedSkills,
} from "./index.js";

const PIN = new Date("2026-10-17T00:00:00.000Z");
const now = () => new Date(PIN.getTime());
const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
  GIT_AUTHOR_DATE: "2026-10-17T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-17T00:00:00Z",
};
const OBJECTIVE = "do the task";

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

class RecordingAdapter extends FakeAdapter {
  readonly seen: { argv: string[]; env: Record<string, string>; envAllowlist: string[]; stdin: string; cwd: string }[] =
    [];

  constructor() {
    super({ timeouts: PATIENT });
  }

  override compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    const inv = super.compile(request, profile);
    if (!isIneligible(inv)) {
      const stdin = inv.stdin?.kind === "text" ? inv.stdin.value : "";
      this.seen.push({
        argv: [...inv.argv],
        env: { ...inv.env },
        envAllowlist: [...inv.envAllowlist],
        stdin,
        cwd: inv.cwd,
      });
    }
    return inv;
  }
}

let cfgDir: string;
let root: string;

beforeEach(() => {
  cfgDir = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-skill-cfg-")));
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-skill-run-")));
  mkdirSync(path.join(cfgDir, "statedata"));
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function write(obj: unknown): string {
  const p = path.join(cfgDir, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const base = () => ({
  schema_version: 1,
  allowed_roots: [root],
  data_dir: path.join(cfgDir, "statedata"),
  mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
});

const project = (over: Record<string, unknown> = {}) => ({
  id: "web-app",
  name: "Web app",
  contexts: [{ id: "main", kind: "repository", path: path.join(root, "repo"), base_ref: "main" }],
  ...over,
});

const client = (over: Record<string, unknown> = {}) => ({
  id: "main",
  max_trust_profile: "edit-untrusted",
  ...over,
});

const load = (extra: Record<string, unknown> = {}) => loadConfig({ configPath: write({ ...base(), ...extra }) });

const FULL_SKILLS = {
  defaults: ["security-review", "security-review@1"],
  roles: { reviewer: ["security-review"], steward: ["other-skill@2"] },
  delivery: "prefix_only",
  allow_draft_in_trusted: true,
  max_body_bytes: 4096,
  max_per_run: 2,
  max_run_bytes: 8192,
  max_names: 16,
};

function stripSkills(c: ResolvedConfig): ResolvedConfig {
  const projects = c.projects.map((p) => {
    const { skills: _skills, ...rest } = p;
    return rest;
  });
  const mcpClients = new Map(
    [...c.mcpClients].map(([id, entry]) => {
      const { skills: _skills, ...rest } = entry;
      return [id, rest] as const;
    }),
  );
  const skills: ResolvedSkills = {
    defaults: [],
    roles: {},
    enabled: false,
    delivery: "native_preferred",
    allowDraftInTrusted: false,
    maxBodyBytes: 0,
    maxPerRun: 0,
    maxRunBytes: 0,
    maxNames: 0,
  };
  return { ...c, projects, mcpClients, skills };
}

describe("unknown skills keys abort startup", () => {
  it("refuses an unknown key in skills, a project skills object and a client", () => {
    expect(() => load({ skills: { nope: true } })).toThrow(/\$\.skills\.nope: unknown key/);
    expect(() => load({ skills: { defaults: ["ab"], extra: 1 } })).toThrow(/\$\.skills\.extra: unknown key/);
    expect(() => load({ projects: [project({ skills: { defaults: ["ab"], extra: true } })] })).toThrow(
      /\$\.projects\[0\]\.skills\.extra: unknown key/,
    );
    expect(() => load({ mcp_clients: [client({ skillz: ["ab"] })] })).toThrow(
      /\$\.mcp_clients\[0\]\.skillz: unknown key/,
    );
  });

  it("refuses a role, a name or a client name that does not match, and duplicate names", () => {
    expect(() => load({ skills: { roles: { Reviewer: ["ab"] } } })).toThrow(/\$\.skills\.roles/);
    expect(() => load({ skills: { defaults: ["a"] } })).toThrow(/\$\.skills\.defaults/);
    expect(() => load({ skills: { defaults: ["ab@0"] } })).toThrow(/\$\.skills\.defaults/);
    expect(() => load({ skills: { defaults: ["ab@01"] } })).toThrow(/\$\.skills\.defaults/);
    expect(() => load({ skills: { defaults: ["ab@1000000"] } })).toThrow(/\$\.skills\.defaults/);
    expect(() => load({ skills: { defaults: ["Ab"] } })).toThrow(/\$\.skills\.defaults/);
    expect(() => load({ skills: { defaults: ["ab", "ab"] } })).toThrow(/\$\.skills\.defaults/);
    expect(() => load({ mcp_clients: [client({ skills: ["ab@1"] })] })).toThrow(/\$\.mcp_clients\[0\]\.skills/);
    expect(() => load({ skills: { delivery: "native" } })).toThrow(/\$\.skills\.delivery/);
  });

  it("accepts name, pin and role shapes and keeps projects[].skills off the dynamic project schema", () => {
    const c = load({
      skills: { defaults: ["ab", "ab@1"], roles: { a: ["ab"], a_b: ["ab@2"] } },
      projects: [project({ skills: { defaults: ["ab"], roles: { reviewer: ["ab@1"] } } })],
      mcp_clients: [client({ skills: [] }), client({ id: "other", skills: ["ab"] })],
    });
    expect(c.skills.defaults).toEqual(["ab", "ab@1"]);
    expect(c.skills.roles).toEqual({ a: ["ab"], a_b: ["ab@2"] });
    expect(c.projects[0]?.skills).toEqual({ defaults: ["ab"], roles: { reviewer: ["ab@1"] } });
    expect(c.mcpClients.get("main")?.skills).toEqual([]);
    expect(c.mcpClients.get("other")?.skills).toEqual(["ab"]);
    expect(projectSchema.additionalProperties).toBe(false);
    expect(Object.keys(projectSchema.properties)).not.toContain("skills");
    expect(JSON.stringify(configSchemaFor(PROVIDER_IDS))).toBe(JSON.stringify(configSchema));
  });

  it("a configured name that is not in the store does not abort startup", () => {
    const off = load({ skills: { enabled: false, defaults: ["not-stored"] } });
    const on = load({ skills: { enabled: true, defaults: ["not-stored"] } });
    expect(off.skills.enabled).toBe(false);
    expect(on.skills.enabled).toBe(true);
    expect(on.skills.defaults).toEqual(["not-stored"]);
  });
});

describe("limits outside their ranges are refused", () => {
  it("refuses a limit outside its Delegated range, a non-integer, and a run total under one body", () => {
    expect(() => load({ skills: { max_body_bytes: 0 } })).toThrow(/\$\.skills\.max_body_bytes/);
    expect(() => load({ skills: { max_body_bytes: MAX_MAX_BODY_BYTES + 1 } })).toThrow(/\$\.skills\.max_body_bytes/);
    expect(() => load({ skills: { max_per_run: 0 } })).toThrow(/\$\.skills\.max_per_run/);
    expect(() => load({ skills: { max_per_run: MAX_MAX_PER_RUN + 1 } })).toThrow(/\$\.skills\.max_per_run/);
    expect(() => load({ skills: { max_run_bytes: 0 } })).toThrow(/\$\.skills\.max_run_bytes/);
    expect(() => load({ skills: { max_run_bytes: MAX_MAX_RUN_BYTES + 1 } })).toThrow(/\$\.skills\.max_run_bytes/);
    expect(() => load({ skills: { max_names: 0 } })).toThrow(/\$\.skills\.max_names/);
    expect(() => load({ skills: { max_names: MAX_MAX_NAMES + 1 } })).toThrow(/\$\.skills\.max_names/);
    expect(() => load({ skills: { max_body_bytes: 1.5 } })).toThrow(/\$\.skills\.max_body_bytes/);
    expect(() => load({ skills: { max_per_run: "8" } })).toThrow(/\$\.skills\.max_per_run/);
    expect(() => load({ skills: { max_body_bytes: 1_000_000 } })).toThrow(/\$\.skills\.max_run_bytes: must be >=/);
    expect(() => load({ skills: { max_run_bytes: 32_767 } })).toThrow(/\$\.skills\.max_run_bytes: must be >=/);
  });

  it("accepts each Delegated endpoint and a run total at least as large as one body", () => {
    const top = load({
      skills: {
        max_body_bytes: MAX_MAX_BODY_BYTES,
        max_per_run: MAX_MAX_PER_RUN,
        max_run_bytes: MAX_MAX_RUN_BYTES,
        max_names: MAX_MAX_NAMES,
      },
    });
    expect(top.skills.maxBodyBytes).toBe(MAX_MAX_BODY_BYTES);
    expect(top.skills.maxPerRun).toBe(MAX_MAX_PER_RUN);
    expect(top.skills.maxRunBytes).toBe(MAX_MAX_RUN_BYTES);
    expect(top.skills.maxNames).toBe(MAX_MAX_NAMES);
    const floor = load({ skills: { max_body_bytes: 1, max_per_run: 1, max_run_bytes: 1, max_names: 1 } });
    expect(floor.skills).toMatchObject({ maxBodyBytes: 1, maxPerRun: 1, maxRunBytes: 1, maxNames: 1 });
    const raised = load({ skills: { max_run_bytes: 1_000_000 } });
    expect(raised.skills.maxRunBytes).toBe(1_000_000);
    expect(raised.skills.maxBodyBytes).toBe(32_768);
  });

  it("refuses a name list or a role map past its Delegated cap", () => {
    const names = Array.from({ length: MAX_MAX_NAMES + 1 }, (_, i) => `n${String(i).padStart(4, "0")}`);
    expect(() => load({ skills: { defaults: names } })).toThrow(/\$\.skills\.defaults/);
    const roles: Record<string, string[]> = {};
    for (let i = 0; i < 129; i++) roles[`r${i}`] = ["ab"];
    expect(() => load({ skills: { roles } })).toThrow(/\$\.skills\.roles/);
  });
});

describe("with skills.enabled false or absent recorded prompts, argv and ledger rows are byte-identical", () => {
  it("an absent section and enabled false resolve to the same skills object", () => {
    const absent = load({});
    const explicit = load({ skills: { enabled: false } });
    const empty = load({ skills: {} });
    expect(explicit).toEqual(absent);
    expect(empty).toEqual(absent);
    expect(absent.skills).toEqual({
      defaults: [],
      roles: {},
      enabled: false,
      delivery: "native_preferred",
      allowDraftInTrusted: false,
      maxBodyBytes: 32_768,
      maxPerRun: 8,
      maxRunBytes: 65_536,
      maxNames: 64,
    });
    const bare = load({});
    expect(bare.projects).toEqual([]);
    expect(bare.mcpClients.get("main")).not.toHaveProperty("skills");
    const listed = load({ projects: [project({ skills: {} })] });
    expect(listed.projects[0]?.skills).toEqual({ defaults: [], roles: {} });
    const plain = load({ projects: [project()] });
    expect(plain.projects[0]).not.toHaveProperty("skills");
  });

  it("a disabled or enabled section changes no other resolved field", () => {
    const shape = {
      projects: [project({ skills: { defaults: ["security-review"], roles: { reviewer: ["security-review@1"] } } })],
      mcp_clients: [client({ skills: ["security-review"] })],
    };
    const absent = load({ projects: [project()], mcp_clients: [client()] });
    const disabled = load({ skills: { enabled: false, ...FULL_SKILLS }, ...shape });
    const enabled = load({ skills: { enabled: true, ...FULL_SKILLS }, ...shape });
    expect(stripSkills(disabled)).toEqual(stripSkills(absent));
    expect(stripSkills(enabled)).toEqual(stripSkills(absent));
    expect(disabled.skills.enabled).toBe(false);
    expect(enabled.skills.enabled).toBe(true);
    expect(disabled.skills.delivery).toBe("prefix_only");
    expect(disabled.skills.allowDraftInTrusted).toBe(true);
    expect(disabled.skills.maxBodyBytes).toBe(4096);
    expect(disabled.projects[0]?.skills?.defaults).toEqual(["security-review"]);
    expect(disabled.mcpClients.get("main")?.skills).toEqual(["security-review"]);
    expect(absent.projects[0]).not.toHaveProperty("skills");
    expect(absent.mcpClients.get("main")).not.toHaveProperty("skills");
  });

  it("recorded prompts, argv and ledger rows are byte-identical", async () => {
    const shape = {
      projects: [project({ skills: { defaults: ["security-review"] } })],
      mcp_clients: [client({ skills: ["security-review"] })],
    };
    const configs = [
      load({}),
      load({ skills: { enabled: false } }),
      load({ skills: { enabled: false, ...FULL_SKILLS }, ...shape }),
      load({ skills: { enabled: true, ...FULL_SKILLS }, ...shape }),
    ];
    // Lifecycle inputs that a run reads stay equal. Project and client skill lists are not among them (T16.4).
    const driving = (c: ResolvedConfig) => ({
      allowedRoots: c.allowedRoots,
      limits: c.limits,
      breaker: c.capacity.breaker,
      retry: c.capacity.retry,
      queueHorizonSeconds: c.capacity.queueHorizonSeconds,
      loopBreaker: c.controlPlane.loopBreaker,
      continuity: c.continuity,
    });
    expect(driving(configs[1] as ResolvedConfig)).toEqual(driving(configs[0] as ResolvedConfig));
    expect(driving(configs[2] as ResolvedConfig)).toEqual(driving(configs[0] as ResolvedConfig));
    expect(driving(configs[3] as ResolvedConfig)).toEqual(driving(configs[0] as ResolvedConfig));

    const runs: { prompt: string; record: string; dump: string }[] = [];
    for (const cfg of configs) runs.push(await runOnce(cfg));
    for (const run of runs) {
      expect(run.prompt).toBe(OBJECTIVE);
      expect(run.prompt).not.toContain("[operator skills:");
      expect(run.record).not.toContain("[operator skills:");
      expect(run.dump).not.toContain("[operator skills:");
    }
    for (const run of runs.slice(1)) {
      expect(run.record).toBe(runs[0]?.record);
      expect(run.dump).toBe(runs[0]?.dump);
    }
  }, 120_000);
});

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

function resetTree(): { repo: string; dataDir: string } {
  for (const name of readdirSync(root)) rmSync(path.join(root, name), { recursive: true, force: true });
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  return { repo, dataDir };
}

function normalize(text: string): string {
  // pid, pgid and start ticks differ per spawn, including inside escaped JSON payloads. The chain hash (ADR-0064)
  // covers those raw payloads, so it differs with them; every other column is still compared.
  return text
    .split(root)
    .join("<root>")
    .replace(/(pid|pgid|proc_start_ticks)\\?":\s*-?\d+/g, '$1":0')
    .replace(/"chain_hash":"[0-9a-f]{64}"/g, '"chain_hash":"<chain>"');
}

function ledgerDump(db: Database.Database): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const parts = tables.map((t) => {
    const rows = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all();
    return `${t.name}\n${JSON.stringify(rows)}`;
  });
  return normalize(parts.join("\n"));
}

async function runOnce(cfg: ResolvedConfig): Promise<{ prompt: string; record: string; dump: string }> {
  const { repo, dataDir } = resetTree();
  const ids = createIdGenerator({
    now: () => PIN.getTime(),
    randomDigits: (n) => Array.from({ length: n }, () => 0),
  });
  const db = openLedger(dataDir, { now });
  const ledger: Ledger = createLedger(db, { ids, now });
  const adapter = new RecordingAdapter();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: cfg.allowedRoots, ids, now });
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: cfg.allowedRoots,
    globalConcurrency: cfg.limits.globalConcurrency,
    perProviderConcurrency: cfg.limits.perProviderConcurrency,
    breaker: cfg.capacity.breaker,
    retry: { ...cfg.capacity.retry, queueHorizonSeconds: cfg.capacity.queueHorizonSeconds },
    loopBreaker: cfg.controlPlane.loopBreaker,
    continuityBounds: cfg.continuity,
    resolveProfile: profileFor,
    now,
  });
  try {
    lifecycle.start();
    const submitted = await lifecycle.submit({
      clientId: "client-a",
      objective: OBJECTIVE,
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "fake",
    });
    const done = await lifecycle.waitForTerminal(submitted.runId);
    expect(done.state).toBe("SUCCEEDED");
    const prompt = adapter.seen[0]?.stdin ?? "";
    return { prompt, record: normalize(JSON.stringify(adapter.seen)), dump: ledgerDump(db) };
  } finally {
    await lifecycle.shutdown();
    db.close();
  }
}
