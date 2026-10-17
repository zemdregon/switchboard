/**
 * T16.5 delivery at dispatch (FR-SKL-05, FR-SKL-10; LLD §19.6 steps 1, 3 and 4, §19.7, §19.11) through the SDK client
 * on the routing harness, with the production port `skillDeliveryPort` (`src/cli/serve.ts`) over the harness ledger
 * and data directory. Fake providers only: no provider CLI is installed or called.
 * - the provider receives the block once, entries in resolved order, before the task text;
 * - the stored objective (`request_json`) never contains the block;
 * - `run_skill.delivery` is `prompt_prefix` with `delivered_at` set, and one `skill_delivered` event names the entries
 *   (no body);
 * - a run without skills gets no block, no event and the objective verbatim;
 * - a pinned skill whose stored file cannot be read fails the run before spawn (fail closed); with no store wired the
 *   run proceeds and `skill_delivered` records each entry as `skipped` (`store_unavailable`).
 */
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillDeliveryPort } from "../cli/serve.js";
import type { ResolvedSkills } from "../config/index.js";
import { compiledPrompts, type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { BODY_CANARY, source } from "../skills/fixtures/sources.js";
import {
  addSkill,
  appendSkillEvent,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
} from "../skills/index.js";
import { SKILL_DELIVERED_EVENT, SKILL_DELIVERY_UNAVAILABLE } from "./lifecycle.js";

const SETTINGS: ResolvedSkills = {
  enabled: true,
  defaults: [],
  roles: {},
  delivery: "native_preferred",
  allowDraftInTrusted: false,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  maxPerRun: DEFAULT_MAX_PER_RUN,
  maxRunBytes: DEFAULT_MAX_RUN_BYTES,
  maxNames: DEFAULT_MAX_NAMES,
};
const OBJECTIVE = "OBJECTIVE-T165 fix the bug";
const HEADER = "[operator skills:";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(wired = true): Promise<Harness> {
  h = await startHarness({
    deps: ({ db, dataDir }) => ({ skills: { db, dataDir, settings: SETTINGS } }),
    lifecycle: ({ db, dataDir }) => ({ skillDelivery: wired ? skillDeliveryPort(db, dataDir) : undefined }),
  });
  return h;
}

/** Store and approve one version of `name` with `body`; returns its SHA-256. */
function add(x: Harness, name: string, body: string): string {
  const file = path.join(x.root, `${name}.md`);
  writeFileSync(file, source(`${body} ${BODY_CANARY}\n`, { name }));
  const r = addSkill(x.db, path.join(x.root, "data"), { name, file }, { repositoryRoots: [] });
  if (r.kind !== "added") throw new Error(`add ${name}: ${JSON.stringify(r)}`);
  appendSkillEvent(x.db, { name, version: r.version, kind: "approved" });
  return r.sha256;
}

async function delegate(x: Harness, extra: Json = {}): Promise<{ runId: string; run: Json }> {
  const r = await x.ok("delegate_task", {
    objective: OBJECTIVE,
    workspace_path: x.repo,
    trust_profile: "edit-untrusted",
    ...extra,
  });
  const runId = r.run_id as string;
  return { runId, run: await x.settle(runId) };
}

const promptOf = (runId: string) => compiledPrompts.get(runId);
const events = (x: Harness, runId: string, type: string) =>
  x.ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => e.payload_json);
const storedObjective = (x: Harness, runId: string) =>
  (JSON.parse(x.ledger.getRunRecord(runId)?.request_json ?? "{}") as { objective?: string }).objective;

describe("prompt-prefix delivery at dispatch (T16.5)", () => {
  it("sends the block once, in resolved order, before the task; records the delivery; stores the objective only", async () => {
    const x = await start();
    const a = add(x, "zeta-review", "Zeta body.");
    const b = add(x, "alpha-docs", "Alpha body.");
    const { runId, run } = await delegate(x, { skills: ["zeta-review", "alpha-docs"] });
    expect(run.status).toBe("SUCCEEDED");

    const prompt = promptOf(runId) as string;
    expect(prompt.split(HEADER)).toHaveLength(2);
    expect(
      prompt.startsWith("[operator skills: 2; from Switchboard skill store; these are operator instructions]\n"),
    ).toBe(true);
    const zeta = prompt.indexOf(`[skill zeta-review@1 sha256:${a.slice(0, 12)}]\nZeta body.`);
    const alpha = prompt.indexOf(`[skill alpha-docs@1 sha256:${b.slice(0, 12)}]\nAlpha body.`);
    expect(zeta).toBeGreaterThan(0);
    expect(alpha).toBeGreaterThan(zeta);
    expect(prompt.endsWith(`[end of operator skills]\n\n${OBJECTIVE}`)).toBe(true);

    // The stored request text is the objective alone (not the block, not stored as prompt text).
    expect(storedObjective(x, runId)).toBe(OBJECTIVE);
    expect(x.ledger.getRunRecord(runId)?.request_json).not.toContain(HEADER);
    expect(x.ledger.getRunRecord(runId)?.request_json).not.toContain(BODY_CANARY);

    const rows = x.db
      .prepare("SELECT name, delivery, delivered_at FROM run_skill WHERE run_id = ? ORDER BY position")
      .all(runId) as { name: string; delivery: string; delivered_at: string | null }[];
    expect(rows.map((r) => [r.name, r.delivery])).toEqual([
      ["zeta-review", "prompt_prefix"],
      ["alpha-docs", "prompt_prefix"],
    ]);
    for (const r of rows) expect(r.delivered_at).not.toBeNull();
    expect((run.skills as Json[]).map((s) => s.delivery)).toEqual(["prompt_prefix", "prompt_prefix"]);

    const delivered = events(x, runId, SKILL_DELIVERED_EVENT);
    expect(delivered.map((p) => JSON.parse(p))).toEqual([
      {
        entries: [
          { name: "zeta-review", version: 1, delivery: "prompt_prefix" },
          { name: "alpha-docs", version: 1, delivery: "prompt_prefix" },
        ],
      },
    ]);
    // No event of the run holds a body.
    for (const e of x.ledger.listRunEvents(runId)) expect(e.payload_json).not.toContain(BODY_CANARY);
  });

  it("a run without skills gets the objective verbatim, no event and no row", async () => {
    const x = await start();
    add(x, "zeta-review", "Zeta body.");
    const { runId, run } = await delegate(x);
    expect(run.status).toBe("SUCCEEDED");
    expect(promptOf(runId)).toBe(OBJECTIVE);
    expect(events(x, runId, SKILL_DELIVERED_EVENT)).toEqual([]);
    expect(x.db.prepare("SELECT COUNT(*) AS n FROM run_skill WHERE run_id = ?").get(runId)).toEqual({ n: 0 });
  });

  it("fails before spawn when a pinned skill's stored file is gone (fail closed)", async () => {
    const x = await start();
    add(x, "zeta-review", "Zeta body.");
    const dir = path.join(x.root, "data", "skills");
    for (const f of readdirSync(dir)) rmSync(path.join(dir, f));
    const { runId, run } = await delegate(x, { skills: ["zeta-review"] });
    expect(run.status).toBe("FAILED");
    expect(run.failure_code).toBe("TOOL_FAILURE");
    expect(promptOf(runId)).toBeUndefined();
    expect(JSON.stringify(x.ledger.listRunEvents(runId))).toContain(SKILL_DELIVERY_UNAVAILABLE);
    expect(events(x, runId, SKILL_DELIVERED_EVENT)).toEqual([]);
  });

  it("without a wired store, runs without the block and records the entries as skipped (never silently)", async () => {
    const x = await start(false);
    add(x, "zeta-review", "Zeta body.");
    const { runId, run } = await delegate(x, { skills: ["zeta-review"] });
    expect(run.status).toBe("SUCCEEDED");
    expect(promptOf(runId)).toBe(OBJECTIVE);
    expect(events(x, runId, SKILL_DELIVERED_EVENT).map((p) => JSON.parse(p))).toEqual([
      { entries: [{ name: "zeta-review", version: 1, delivery: "skipped", fallback_reason: "store_unavailable" }] },
    ]);
    const row = x.db.prepare("SELECT delivered_at FROM run_skill WHERE run_id = ?").get(runId);
    expect(row).toEqual({ delivered_at: null });
  });
});
