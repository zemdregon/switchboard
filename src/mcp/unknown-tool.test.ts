/**
 * Unknown-tool error details (mcp-test-results/20261019T195233Z.md finding 1, minor, non-blocking): the
 * INVALID_REQUEST for an unknown tool used to list `details.tools` from the hardcoded `TOOL_NAMES` array (14
 * names), missing the work-queue and skill tools the server actually registers. The list is now derived from the
 * same descriptors `tools/list` returns, so this test pins them together: `details.tools` must equal the sorted
 * set of names from `tools/list`, for both an orchestrator and a console client.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrustProfile } from "../ledger/index.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";

const edit: TrustProfile = "edit-untrusted";
let h: Harness;
beforeEach(async () => {
  h = await startHarness({
    config: {
      mcpClients: new Map([
        ["orch", { id: "orch", maxTrustProfile: edit }],
        ["other", { id: "other", maxTrustProfile: edit, toolProfile: "console" as const }],
      ]),
    },
  });
});
afterEach(async () => {
  await h.close();
});

const sorted = (names: string[]): string[] => [...names].sort();

describe("unknown-tool details.tools (mcp-test 20261019T195233Z finding 1)", () => {
  it("lists every tool an orchestrator client is offered, matching tools/list", async () => {
    const { tools } = await h.client("orch").listTools();
    const listed = sorted(tools.map((t) => t.name));
    // The work-queue tools are registered for this client; the stale TOOL_NAMES-only list missed them.
    expect(listed).toEqual(expect.arrayContaining(["enqueue_work", "list_work", "cancel_work"]));
    const r = await h.call("no_such_tool", {}, "orch");
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", retryable: false });
    expect(r.body.error.message).toContain('unknown tool "no_such_tool"');
    expect(sorted(r.body.error.details.tools)).toEqual(listed);
  });

  it("respects the console tool profile: a console client sees only its own tools", async () => {
    const { tools } = await h.client("other").listTools();
    const listed = sorted(tools.map((t) => t.name));
    expect(listed).not.toContain("cancel_run");
    const r = await h.call("cancel_run", {}, "other");
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(sorted(r.body.error.details.tools)).toEqual(listed);
  });
});
