/**
 * T14.11 (FR-CTL-11, FR-MCP-02, LLD §3.4.10): per-client `tool_profile` through the SDK client. In `h`, `orch` has no
 * profile (the default) and `other` is `console`; in `h2`, `orch` sets `orchestrator` explicitly and `other` is
 * `console` with `approval_proxy`. The console list must be exactly the closed console set the server registers, with
 * the published closed schemas; the orchestrator list must be unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalProxyToolDescriptors } from "../control/approval-proxy.js";
import type { TrustProfile } from "../ledger/index.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import { inputSchema, outputSchema, TOOL_NAMES, type ToolName, toolDescriptors } from "./schemas.js";
import { applyToolProfile, CONSOLE_TOOL_NAMES, profileOffers } from "./tool-profile.js";

const edit: TrustProfile = "edit-untrusted";
let h: Harness;
let hOpen = false;
let h2: Harness | undefined;
beforeEach(async () => {
  h = await startHarness({
    config: {
      mcpClients: new Map([
        ["orch", { id: "orch", maxTrustProfile: edit }],
        ["other", { id: "other", maxTrustProfile: edit, toolProfile: "console" as const }],
      ]),
    },
  });
  hOpen = true;
});
afterEach(async () => {
  if (hOpen) await h.close();
  await h2?.close();
  h2 = undefined;
});

/**
 * `orch` with an explicit `orchestrator`, `other` as a console client with `approval_proxy`. The harness registers a
 * process-wide fake provider, so `h` is closed first.
 */
const second = async (): Promise<Harness> => {
  await h.close();
  hOpen = false;
  h2 = await startHarness({
    config: {
      mcpClients: new Map([
        ["orch", { id: "orch", maxTrustProfile: edit, toolProfile: "orchestrator" as const }],
        ["other", { id: "other", maxTrustProfile: edit, toolProfile: "console" as const, approvalProxy: true }],
      ]),
    },
  });
  return h2;
};

const names = async (x: Harness, clientId: string): Promise<string[]> =>
  (await x.client(clientId).listTools()).tools.map((t) => t.name);

/** The console names this server registers today (T14.6 adds the pause tools when their handlers land). */
const registeredConsole = CONSOLE_TOOL_NAMES.filter((n) => (TOOL_NAMES as readonly string[]).includes(n));

describe("tool_profile console (T14.11, FR-CTL-11)", () => {
  it("tools/list returns exactly the registered console set with the published closed schemas", async () => {
    const { tools } = await h.client("other").listTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(new Set(registeredConsole));
    expect(tools).toHaveLength(registeredConsole.length);
    // Every registered tool that is not in the console set is absent (FR-MCP-02's get_capacity and explain_route too).
    for (const n of ["continue_task", "cancel_run", "get_artifacts", "list_capabilities", "list_projects"]) {
      expect(tools.map((t) => t.name)).not.toContain(n);
    }
    expect(tools.map((t) => t.name)).not.toContain("get_capacity");
    expect(tools.map((t) => t.name)).not.toContain("explain_route");
    for (const t of tools) {
      expect(t.inputSchema).toEqual(inputSchema(t.name as ToolName));
      expect(t.outputSchema).toEqual(outputSchema(t.name as ToolName));
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("adds the approval-proxy tools only for an approval_proxy client, regardless of profile (ADR-0047)", async () => {
    const proxy = approvalProxyToolDescriptors().map((d) => d.name);
    const plain = await names(h, "other");
    expect(plain).not.toEqual(expect.arrayContaining(proxy));
    expect(await names(await second(), "other")).toEqual([...plain, ...proxy]);
  });

  it("answers a call to an orchestrator-only tool exactly like an unknown tool and lists only its own tools", async () => {
    for (const tool of ["cancel_run", "continue_task", "get_capacity", "explain_route", "list_projects"]) {
      const r = await h.call(tool, {}, "other");
      expect(r.isError, tool).toBe(true);
      expect(r.body.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining(`unknown tool "${tool}"`),
        details: { tools: TOOL_NAMES.filter((n) => (registeredConsole as readonly string[]).includes(n)) },
      });
    }
    for (const tool of ["create_project", "search_project_context", "list_pending_approvals"]) {
      const r = await h.call(tool, {}, "other");
      expect(r.body.error, tool).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("serves the console tools through the same pipeline as an orchestrator client", async () => {
    const run = await h.ok(
      "delegate_task",
      { objective: "Fix the parser crash", workspace_path: h.repo, trust_profile: "edit-untrusted" },
      "other",
    );
    await h.lifecycle.waitForTerminal(String(run.run_id));
    expect(await h.ok("get_run", { run_id: run.run_id }, "other")).toMatchObject({ run_id: run.run_id });
    const rows = (await h.ok("list_runs", {}, "other")).runs as { run_id: string }[];
    expect(rows.map((r) => r.run_id)).toContain(run.run_id);
    expect(await h.ok("get_digest", {}, "other")).toHaveProperty("cursor");
  });
});

describe("tool_profile orchestrator (T14.11, FR-CTL-11)", () => {
  it("is unchanged: the default and the explicit orchestrator list today's full set with the same schemas", async () => {
    const expected = JSON.parse(JSON.stringify(toolDescriptors())) as unknown;
    const check = async (label: string, x: Harness) => {
      const { tools } = await x.client("orch").listTools();
      expect(
        tools.map((t) => t.name),
        label,
      ).toEqual([...TOOL_NAMES]);
      expect(JSON.parse(JSON.stringify(tools)), label).toEqual(expected);
      expect(await x.call("get_capacity", {}, "orch"), label).toMatchObject({ isError: false });
    };
    await check("default", h);
    await check("explicit", await second());
  });
});

describe("applyToolProfile (T14.11)", () => {
  const descriptor = (name: string) => ({ name });
  // A Set, so the list stays duplicate-free as T14.6 adds the pause tools to TOOL_NAMES (T14.7 added steer_run).
  const all = [
    ...new Set([
      ...TOOL_NAMES,
      "steer_run",
      "pause_project",
      "resume_project",
      "create_project",
      "update_project",
      "delete_project",
      "search_project_context",
    ]),
  ].map(descriptor);

  it("keeps exactly the seven console tools once steer_run and the pause tools are registered", () => {
    expect(
      applyToolProfile("console", all)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...CONSOLE_TOOL_NAMES].sort());
    expect(CONSOLE_TOOL_NAMES).toEqual([
      "get_digest",
      "list_runs",
      "get_run",
      "delegate_task",
      "steer_run",
      "pause_project",
      "resume_project",
    ]);
  });

  it("returns an orchestrator or absent profile's list as is", () => {
    expect(applyToolProfile("orchestrator", all)).toBe(all);
    expect(applyToolProfile(undefined, all)).toBe(all);
    expect(profileOffers(undefined, "cancel_run")).toBe(true);
    expect(profileOffers("console", "cancel_run")).toBe(false);
    expect(profileOffers("console", "decide_approval")).toBe(true);
  });
});
