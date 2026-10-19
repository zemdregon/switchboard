/**
 * Live-test budget guard (T8.9, NFR-MAINT-05; TDD §3.6). The decision is tested with an injected clock; the scripts are
 * run end to end with the fake plug-in (`scripts/live/providers/fake.mjs`), which records when it is reached and the
 * compile request it receives, and stops the flow before `dist/` or any process. No provider CLI is involved.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE = path.join(ROOT, "scripts", "live-smoke.mjs");
const PAIR = path.join(ROOT, "scripts", "live-pair.mjs");
const MALICIOUS = path.join(ROOT, "scripts", "live-malicious.mjs");
const budgetMod = await import(pathToFileURL(path.join(ROOT, "scripts", "live", "budget.mjs")).href);
const { admitLiveRun, decide, EXIT_REFUSED, modelHandoff, parseBudget, withBudgetModel } = budgetMod;

const T0 = Date.parse("2026-10-17T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const start = (ms: number, providers: Record<string, number>) => ({
  ts: iso(ms),
  event: "start",
  providers: Object.fromEntries(Object.entries(providers).map(([id, runs]) => [id, { runs }])),
});

let dir: string;
let file: string;
let audit: string;
let fakeRecord: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "switchboard-live-budget-"));
  file = path.join(dir, "budget.json");
  audit = `${file}.jsonl`;
  fakeRecord = path.join(dir, "fake.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeBudget = (over: Record<string, unknown> = {}) =>
  writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      window_hours: 24,
      global_max_runs: 4,
      min_gap_seconds: 0,
      purposes: ["pre-check", "final-verify"],
      providers: {
        fake: { max_runs: 1, model: "fake-file-model" },
        claude: { max_runs: 2, model: "claude-file-model" },
      },
      ...over,
    }),
  );
const writeAudit = (records: unknown[]) => writeFileSync(audit, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
const readJsonl = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function runScript(script: string, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [script], {
    env: { SWITCHBOARD_LIVE_TESTS: "1", SWITCHBOARD_LIVE_FAKE_RECORD: fakeRecord, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const smoke = (env: Record<string, string> = {}) =>
  runScript(SMOKE, {
    SWITCHBOARD_LIVE_PROVIDER: "fake",
    SWITCHBOARD_LIVE_BUDGET_FILE: file,
    SWITCHBOARD_LIVE_PURPOSE: "pre-check",
    ...env,
  });

describe("budget decision with an injected clock (T8.9)", () => {
  const parsed = (over: Record<string, unknown> = {}) => {
    const doc = {
      schema_version: 1,
      window_hours: 24,
      global_max_runs: 3,
      min_gap_seconds: 600,
      purposes: ["pre-check"],
      providers: { fake: { max_runs: 2, model: "m-fake" }, claude: { max_runs: 2, model: "m-claude" } },
      ...over,
    };
    const r = parseBudget(doc, "/operator/budget.json", ROOT);
    expect(r.ok, r.reason).toBe(true);
    return r.budget;
  };

  it("refuses the run past the per-provider cap and admits it again once the window has rolled past", () => {
    const b = parsed();
    const records = [start(T0 - 23 * HOUR, { fake: 1 }), start(T0 - 2 * HOUR, { fake: 1 })];
    const ask = (nowMs: number) => decide(b, records, { runs: { fake: 1 }, purpose: "pre-check", nowMs });
    expect(ask(T0)).toEqual({ allow: false, reason: "fake cap: 2 of 2 provider runs used in the window, 1 requested" });
    expect(ask(T0 + HOUR + 1)).toEqual({ allow: true, models: { fake: "m-fake" } });
  });

  it("refuses past the global cap, counting each provider run of a pair", () => {
    const b = parsed();
    const records = [start(T0 - HOUR, { claude: 1 })];
    expect(decide(b, records, { runs: { fake: 1, claude: 1 }, purpose: "pre-check", nowMs: T0 }).allow).toBe(true);
    expect(decide(b, records, { runs: { fake: 2, claude: 1 }, purpose: "pre-check", nowMs: T0 })).toEqual({
      allow: false,
      reason: "global cap: 1 of 3 provider runs used in the window, 3 requested",
    });
  });

  it("refuses a run inside the minimum gap and admits it at the gap's end; denied records do not count", () => {
    const b = parsed();
    const records = [start(T0 - 5 * MIN, { claude: 1 }), { ts: iso(T0 - MIN), event: "denied", providers: {} }];
    expect(decide(b, records, { runs: { fake: 1 }, purpose: "pre-check", nowMs: T0 })).toEqual({
      allow: false,
      reason: "inside the minimum gap: 300 s until the next run may start",
    });
    expect(decide(b, records, { runs: { fake: 1 }, purpose: "pre-check", nowMs: T0 + 5 * MIN }).allow).toBe(true);
  });

  it("refuses an unknown or missing purpose and a provider the file does not list", () => {
    const b = parsed();
    expect(decide(b, [], { runs: { fake: 1 }, purpose: "just-checking", nowMs: T0 }).reason).toBe(
      'purpose "just-checking" is not on the budget file\'s allowlist',
    );
    expect(decide(b, [], { runs: { fake: 1 }, purpose: undefined, nowMs: T0 }).allow).toBe(false);
    expect(decide(b, [], { runs: { codex: 1 }, purpose: "pre-check", nowMs: T0 }).reason).toBe(
      "provider codex is not in the budget file",
    );
  });

  it("rejects malformed files and paths inside the repository", () => {
    const base = {
      schema_version: 1,
      window_hours: 24,
      global_max_runs: 1,
      min_gap_seconds: 0,
      purposes: [],
      providers: {},
    };
    expect(parseBudget({ ...base, extra: 1 }, "/o/b.json", ROOT).ok).toBe(false);
    expect(parseBudget({ ...base, schema_version: 2 }, "/o/b.json", ROOT).ok).toBe(false);
    expect(parseBudget({ ...base, providers: { fake: { max_runs: 1 } } }, "/o/b.json", ROOT).ok).toBe(false);
    expect(
      parseBudget({ ...base, providers: { fake: { max_runs: 1, model: "--yolo x" } } }, "/o/b.json", ROOT).ok,
    ).toBe(false);
    expect(parseBudget({ ...base, audit_log: path.join(ROOT, "audit.jsonl") }, "/o/b.json", ROOT).reason).toBe(
      "budget file: audit_log must be outside the repository",
    );
    expect(parseBudget(base, "/o/b.json", ROOT).budget.auditLog).toBe("/o/b.json.jsonl");
  });

  it("admitLiveRun appends start and finish records at the injected time, with the file's models", () => {
    writeBudget({ min_gap_seconds: 600 });
    let finish: ((code: number) => void) | undefined;
    const r = admitLiveRun({
      script: "test",
      runs: { fake: 1 },
      repoRoot: ROOT,
      env: { SWITCHBOARD_LIVE_BUDGET_FILE: file, SWITCHBOARD_LIVE_PURPOSE: "final-verify" },
      now: () => T0,
      onExit: (fn: (code: number) => void) => {
        finish = fn;
      },
    });
    expect(r).toEqual({ configured: true, allowed: true, models: { fake: "fake-file-model" } });
    finish?.(0);
    const recs = readJsonl(audit);
    expect(recs.map((x) => [x.event, x.ts, x.purpose, x.exit_code])).toEqual([
      ["start", iso(T0), "final-verify", undefined],
      ["finish", iso(T0), "final-verify", 0],
    ]);
    expect(recs[0].providers).toEqual({ fake: { runs: 1, model: "fake-file-model" } });
    // One minute later the gap refuses, with a denied record.
    const again = admitLiveRun({
      script: "test",
      runs: { claude: 1 },
      repoRoot: ROOT,
      env: { SWITCHBOARD_LIVE_BUDGET_FILE: file, SWITCHBOARD_LIVE_PURPOSE: "final-verify" },
      now: () => T0 + MIN,
      onExit: () => {},
    });
    expect(again.allowed).toBe(false);
    expect(readJsonl(audit).at(-1)).toMatchObject({ event: "denied", ts: iso(T0 + MIN), reason: again.reason });
  });

  it("without the variable it warns once, changes nothing and writes no file", () => {
    const warnings: string[] = [];
    const r = admitLiveRun({
      script: "live-smoke",
      runs: { fake: 1 },
      repoRoot: ROOT,
      env: {},
      warn: (s: string) => warnings.push(s),
    });
    expect(r).toEqual({ configured: false });
    expect(warnings).toEqual([
      "live-smoke: warning: SWITCHBOARD_LIVE_BUDGET_FILE is not set; no live-test budget is enforced (NFR-MAINT-05)",
    ]);
    expect(readdirSync(dir)).toEqual([]);
    expect(modelHandoff(undefined)).toEqual({ provider: undefined, routing: {} });
    const req = { runId: "r", objective: "x" };
    expect(withBudgetModel(req, undefined)).toBe(req);
  });

  it("the file's model replaces whatever model the request asked for", () => {
    expect(withBudgetModel({ runId: "r", model: "asked" }, "from-file")).toEqual({ runId: "r", model: "from-file" });
    expect(modelHandoff("from-file")).toEqual({
      provider: { models: { ids: ["from-file"], capabilities: { "from-file": "low" } } },
      routing: { minimum_capability: "low" },
    });
  });
});

describe("live scripts under the budget file, with the fake plug-in (T8.9)", () => {
  it("the run past the cap is refused with exit 75 and a denied record, and the fake is never spawned", () => {
    writeBudget();
    writeAudit([start(Date.now() - 10 * MIN, { fake: 1 })]);
    const r = smoke();
    expect(r.status).toBe(EXIT_REFUSED);
    expect(r.status).toBe(75);
    expect(r.stderr).toContain("live-smoke: REFUSED by the live-test budget: fake cap: 1 of 1 provider runs used");
    const last = readJsonl(audit).at(-1);
    expect(last).toMatchObject({
      event: "denied",
      script: "live-smoke",
      purpose: "pre-check",
      providers: { fake: { runs: 1 } },
    });
    expect(existsSync(fakeRecord)).toBe(false);
  });

  it("refuses a run inside the minimum gap and an unknown purpose, never reaching the fake", () => {
    writeBudget({ min_gap_seconds: 3600, providers: { fake: { max_runs: 9, model: "fake-file-model" } } });
    writeAudit([start(Date.now() - 10_000, { claude: 1 })]);
    const gap = smoke();
    expect(gap.status).toBe(75);
    expect(gap.stderr).toContain("inside the minimum gap");
    writeAudit([]);
    const purpose = smoke({ SWITCHBOARD_LIVE_PURPOSE: "just-checking" });
    expect(purpose.status).toBe(75);
    expect(purpose.stderr).toContain('purpose "just-checking" is not on the budget file\'s allowlist');
    expect(readJsonl(audit).map((x) => x.event)).toEqual(["denied"]);
    expect(existsSync(fakeRecord)).toBe(false);
  });

  it("refuses (exit 75, fake not spawned) a missing, malformed or in-repository budget file", () => {
    for (const f of [path.join(dir, "missing.json"), "relative.json", path.join(ROOT, "package.json")]) {
      const r = smoke({ SWITCHBOARD_LIVE_BUDGET_FILE: f });
      expect(r.status, f).toBe(75);
    }
    writeFileSync(file, "{ not json");
    expect(smoke().status).toBe(75);
    expect(existsSync(fakeRecord)).toBe(false);
  });

  it("the model the fake receives is the file's, whatever the test asked for; start and finish are recorded", () => {
    writeBudget();
    const r = smoke({ SWITCHBOARD_LIVE_MODEL: "asked-model" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("live-smoke: fixture plug-in fake stopped after the budget guard");
    expect(readJsonl(fakeRecord)).toEqual([
      { hook: "createAdapter" },
      { hook: "compile", runId: "run_smoke", model: "fake-file-model" },
    ]);
    const recs = readJsonl(audit);
    expect(recs.map((x) => x.event)).toEqual(["start", "finish"]);
    expect(recs[1]).toMatchObject({ exit_code: 0, providers: { fake: { runs: 1, model: "fake-file-model" } } });
    expect(recs[0].run).toBe(recs[1].run);
  });

  it("live-pair counts one provider run per provider of each direction and passes each provider's model", () => {
    writeBudget({
      providers: { fake: { max_runs: 1, model: "fake-file-model" }, claude: { max_runs: 1, model: "c-m" } },
    });
    const pair = (spec: string) =>
      runScript(PAIR, {
        SWITCHBOARD_LIVE_PAIR: spec,
        SWITCHBOARD_LIVE_BUDGET_FILE: file,
        SWITCHBOARD_LIVE_PURPOSE: "final-verify",
      });
    const ok = pair("claude:fake");
    expect(ok.status, ok.stderr).toBe(0);
    expect(readJsonl(fakeRecord)).toEqual([
      { hook: "createAdapter" },
      { hook: "compile", runId: "run_pair", model: "fake-file-model" },
    ]);
    expect(readJsonl(audit)[0].providers).toEqual({
      claude: { runs: 1, model: "c-m" },
      fake: { runs: 1, model: "fake-file-model" },
    });
    rmSync(fakeRecord);
    const capped = pair("fake:claude");
    expect(capped.status).toBe(75);
    expect(capped.stderr).toContain("live-pair: REFUSED by the live-test budget: fake cap: 1 of 1");
    expect(readJsonl(audit).map((x) => x.event)).toEqual(["start", "finish", "denied"]);
    expect(existsSync(fakeRecord)).toBe(false);
  });
});

describe("live-smoke for a plug-in with a forced failed turn (T4.68, decision 74)", () => {
  it("asks the guard for two kimi runs (the smoke task and the failed turn), before dist/ or any CLI", () => {
    writeBudget({ global_max_runs: 9, providers: { kimi: { max_runs: 1, model: "m" } } });
    writeAudit([]);
    const r = runScript(SMOKE, {
      SWITCHBOARD_LIVE_PROVIDER: "kimi",
      SWITCHBOARD_LIVE_BUDGET_FILE: file,
      SWITCHBOARD_LIVE_PURPOSE: "pre-check",
    });
    expect(r.status).toBe(EXIT_REFUSED);
    expect(r.stderr).toContain("kimi cap: 0 of 1 provider runs used in the window, 2 requested");
    expect(readJsonl(audit).at(-1)).toMatchObject({ event: "denied", providers: { kimi: { runs: 2 } } });
    expect(r.stdout).toBe("");
  });
});

describe("live-malicious under the budget file (T8.9)", () => {
  const malicious = (env: Record<string, string> = {}) =>
    runScript(MALICIOUS, {
      SWITCHBOARD_LIVE_MALICIOUS: "1",
      SWITCHBOARD_LIVE_PROVIDER: "claude",
      SWITCHBOARD_LIVE_BUDGET_FILE: file,
      SWITCHBOARD_LIVE_PURPOSE: "pre-check",
      ...env,
    });

  it("a live-malicious invocation past the cap is refused with exit 75 and a denied record, before dist/ or any CLI", () => {
    writeBudget({
      global_max_runs: 9,
      providers: { claude: { max_runs: 3, model: "claude-file-model" } },
    });
    writeAudit([start(Date.now() - 10 * MIN, { claude: 3 })]);
    const r = malicious();
    expect(r.status).toBe(EXIT_REFUSED);
    expect(r.status).toBe(75);
    expect(r.stderr).toContain("live-malicious: REFUSED by the live-test budget: claude cap: 3 of 3");
    const last = readJsonl(audit).at(-1);
    expect(last).toMatchObject({
      event: "denied",
      script: "live-malicious",
      purpose: "pre-check",
      providers: { claude: { runs: 3 } },
    });
    // The admitted path (dist/ load, provider probe, serve) was never reached: no stdout, no record beyond denied.
    expect(r.stdout).toBe("");
    expect(readJsonl(audit).map((x) => x.event)).toEqual(["start", "denied"]);
  });

  it("each provider asks the guard for exactly its MODEL_RUNS count (at most 3), before dist/ or any CLI", async () => {
    const { MODEL_RUNS } = await import(pathToFileURL(MALICIOUS).href);
    for (const [provider, runs] of Object.entries(MODEL_RUNS as Record<string, number>)) {
      expect(runs, provider).toBeLessThanOrEqual(3);
      // A cap one below the request refuses it, and the denied record names the requested count.
      writeBudget({ global_max_runs: 9, providers: { [provider]: { max_runs: runs - 1, model: "m" } } });
      writeAudit([]);
      const r = malicious({ SWITCHBOARD_LIVE_PROVIDER: provider });
      expect(r.status, provider).toBe(EXIT_REFUSED);
      expect(r.stderr, provider).toContain(
        `${provider} cap: 0 of ${runs - 1} provider runs used in the window, ${runs} requested`,
      );
      expect(readJsonl(audit).at(-1), provider).toMatchObject({ event: "denied", providers: { [provider]: { runs } } });
      expect(r.stdout, provider).toBe("");
    }
  });
});

describe("unconfigured runs stay as on main (T8.9)", () => {
  it("skip and usage messages are byte-identical to main and do not list the fake plug-in", () => {
    const skipSmoke = runScript(SMOKE, { SWITCHBOARD_LIVE_TESTS: "0" });
    expect(skipSmoke.stdout).toBe(
      "live-smoke: SKIPPED (opt-in). Set SWITCHBOARD_LIVE_TESTS=1 and SWITCHBOARD_LIVE_PROVIDER=agy|claude|codex|cursor|grok|kimi|opencode to run it.\n",
    );
    const skipPair = runScript(PAIR, { SWITCHBOARD_LIVE_TESTS: "0" });
    expect(skipPair.stdout).toBe(
      "live-pair: SKIPPED (opt-in). Set SWITCHBOARD_LIVE_TESTS=1 (and optionally SWITCHBOARD_LIVE_PAIR=<first>:<second> from agy|claude|codex|cursor|grok|kimi|opencode) to run it.\n",
    );
    const unknown = runScript(SMOKE, { SWITCHBOARD_LIVE_PROVIDER: "nope" });
    expect([unknown.status, unknown.stdout, unknown.stderr]).toEqual([
      2,
      "",
      "live-smoke: SWITCHBOARD_LIVE_PROVIDER must be one of agy, claude, codex, cursor, grok, kimi, opencode\n",
    ]);
    const badPair = runScript(PAIR, { SWITCHBOARD_LIVE_PAIR: "claude:nope" });
    expect([badPair.status, badPair.stderr]).toEqual([
      2,
      "live-pair: unknown provider plug-in nope; expected one of agy, claude, codex, cursor, grok, kimi, opencode\n",
    ]);
  });

  it("without the variable a run warns once on stderr and proceeds with the requested model, recording nothing", () => {
    const r = runScript(SMOKE, { SWITCHBOARD_LIVE_PROVIDER: "fake", SWITCHBOARD_LIVE_MODEL: "asked-model" });
    expect(r.status).toBe(0);
    expect(readJsonl(fakeRecord)).toEqual([
      { hook: "createAdapter" },
      { hook: "compile", runId: "run_smoke", model: "asked-model" },
    ]);
    const plain = runScript(SMOKE, { SWITCHBOARD_LIVE_PROVIDER: "fake" });
    expect(readJsonl(fakeRecord).at(-1)).toEqual({ hook: "compile", runId: "run_smoke", model: null });
    expect(readdirSync(dir)).toEqual(["fake.jsonl"]);
    for (const out of [r, plain]) {
      expect(out.status).toBe(0);
      expect(out.stdout).toBe("live-smoke: fixture plug-in fake stopped after the budget guard\n");
      expect(out.stderr).toBe(
        "live-smoke: warning: SWITCHBOARD_LIVE_BUDGET_FILE is not set; no live-test budget is enforced (NFR-MAINT-05)\n",
      );
    }
  });
});

describe("CI never sets the budget variable (T8.9)", () => {
  it("no workflow, npm script or CI environment names SWITCHBOARD_LIVE_BUDGET_FILE", () => {
    const wf = path.join(ROOT, ".github", "workflows");
    for (const f of readdirSync(wf)) {
      const text = readFileSync(path.join(wf, f), "utf8");
      expect(text, f).not.toContain("SWITCHBOARD_LIVE_BUDGET_FILE");
      expect(text, f).not.toContain("SWITCHBOARD_LIVE_TESTS");
    }
    const pkg = readFileSync(path.join(ROOT, "package.json"), "utf8");
    expect(pkg).not.toContain("SWITCHBOARD_LIVE_BUDGET_FILE");
    if (process.env.CI) expect(process.env.SWITCHBOARD_LIVE_BUDGET_FILE).toBeUndefined();
  });
});
