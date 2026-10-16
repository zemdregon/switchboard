import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLedger, openLedger } from "../ledger/index.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cli-schedule-")));
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
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    env: {},
    user: "operator",
    now: () => new Date("2026-10-16T11:00:00.000Z"),
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

describe("Operator CLI schedules (T15.2; FR-OPS-01, FR-QUE-02, LLD §18.5)", () => {
  it("schedule list reports empty list when none exist", async () => {
    const res = await run(["schedule", "list", ...cfg()]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("No schedules found");

    const jsonRes = await run(["schedule", "list", "--json", ...cfg()]);
    expect(jsonRes.code).toBe(0);
    const parsed = JSON.parse(jsonRes.out) as { schedules: unknown[] };
    expect(parsed.schedules).toEqual([]);
  });

  it("schedule create adds a schedule (off by default)", async () => {
    const res = await run([
      "schedule",
      "create",
      "*/15 * * * *",
      "proj-1",
      JSON.stringify({ objective: "sync data", trust_profile: "inspect-untrusted", project: "proj-1" }),
      ...cfg(),
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("created (off by default)");

    // Verify in ledger
    const schedules = withLedger((l) => l.listSchedules());
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cron_expr).toBe("*/15 * * * *");
    expect(schedules[0]?.enabled).toBe(0); // Off by default
    expect(schedules[0]?.approval_state).toBe("APPROVED");
  });

  it("schedule show displays schedule details and next fire time", async () => {
    const sch = withLedger((l) =>
      l.createSchedule({
        projectId: "proj-1",
        creatorClientId: "operator",
        cronExpr: "0 * * * *",
        template: { objective: "hourly audit" },
        enabled: true,
      }),
    );

    const res = await run(["schedule", "show", sch.id, ...cfg()]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(sch.id);
    expect(res.out).toContain("0 * * * *");
    expect(res.out).toContain("hourly audit");

    const jsonRes = await run(["schedule", "show", sch.id, "--json", ...cfg()]);
    expect(jsonRes.code).toBe(0);
    const parsed = JSON.parse(jsonRes.out) as { schedule: { id: string; enabled: boolean; next_fire_utc: string } };
    expect(parsed.schedule.id).toBe(sch.id);
    expect(parsed.schedule.enabled).toBe(true);
    expect(parsed.schedule.next_fire_utc).toBeDefined();
  });

  it("schedule enable and disable toggle active status", async () => {
    const sch = withLedger((l) =>
      l.createSchedule({
        projectId: "proj-1",
        creatorClientId: "operator",
        cronExpr: "0 * * * *",
        template: { objective: "test" },
      }),
    );
    expect(sch.enabled).toBe(0);

    // Enable
    const enRes = await run(["schedule", "enable", sch.id, ...cfg()]);
    expect(enRes.code).toBe(0);
    expect(enRes.out).toContain(`Schedule ${sch.id} enabled.`);
    expect(withLedger((l) => l.getSchedule(sch.id)?.enabled)).toBe(1);

    // Disable
    const disRes = await run(["schedule", "disable", sch.id, ...cfg()]);
    expect(disRes.code).toBe(0);
    expect(disRes.out).toContain(`Schedule ${sch.id} disabled.`);
    const updated = withLedger((l) => l.getSchedule(sch.id));
    expect(updated?.enabled).toBe(0);
    expect(updated?.disabled_at).toBeDefined();
  });

  it("schedule approve and deny handle widening approval flow", async () => {
    const pendingSch = withLedger((l) =>
      l.createSchedule({
        projectId: "proj-1",
        creatorClientId: "chat-bot",
        cronExpr: "* * * * *",
        template: { objective: "privileged work" },
        approvalState: "PENDING_APPROVAL",
      }),
    );

    // Attempting to enable fails while PENDING_APPROVAL
    const failEnable = await run(["schedule", "enable", pendingSch.id, ...cfg()]);
    expect(failEnable.code).toBe(2);
    expect(failEnable.err).toContain("requires operator approval");

    // Approve
    const appRes = await run(["schedule", "approve", pendingSch.id, ...cfg()]);
    expect(appRes.code).toBe(0);
    expect(appRes.out).toContain("approved");

    const approvedSch = withLedger((l) => l.getSchedule(pendingSch.id));
    expect(approvedSch?.approval_state).toBe("APPROVED");
    expect(approvedSch?.enabled).toBe(0); // Off by default

    // Now enable succeeds
    const enRes = await run(["schedule", "enable", pendingSch.id, ...cfg()]);
    expect(enRes.code).toBe(0);
    expect(withLedger((l) => l.getSchedule(pendingSch.id)?.enabled)).toBe(1);

    // Deny
    const denyRes = await run(["schedule", "deny", pendingSch.id, ...cfg()]);
    expect(denyRes.code).toBe(0);
    expect(denyRes.out).toContain("denied");
    const deniedSch = withLedger((l) => l.getSchedule(pendingSch.id));
    expect(deniedSch?.approval_state).toBe("REJECTED");
    expect(deniedSch?.enabled).toBe(0);
  });

  it("schedule show returns NOT_FOUND for unknown schedule id", async () => {
    const res = await run(["schedule", "show", "sch_unknown", "--json", ...cfg()]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.out) as { error: { code: string } };
    expect(parsed.error.code).toBe("NOT_FOUND");
  });
});
