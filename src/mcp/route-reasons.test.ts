/**
 * The envelope's `route.reasons` lines (LLD §3). Regression for prod 2026-10-20: a privileged run routed through a
 * model group with two members of one provider listed `claude: excluded PROFILE_UNSUPPORTED` twice while selecting
 * claude. Each member gets its own label, and a compile verdict deferred to dispatch reads as deferred.
 */
import { describe, expect, it } from "vitest";
import type { Ledger, RunRecord } from "../ledger/index.js";
import { routeReasons } from "./envelope.js";

const deferredReason = { code: "PROFILE_UNSUPPORTED", detail: "bypassApproved is false at admission" };

const decision = (candidates: unknown[], basis: string) => ({
  candidates_json: JSON.stringify(candidates),
  selected_provider: "claude",
  reasons_json: JSON.stringify({ selection: { provider: "claude", basis } }),
});

const ledgerWith = (row: ReturnType<typeof decision>) => ({ getRouteDecision: () => row }) as unknown as Ledger;
const run = (trust_profile: string) => ({ id: "run_x", trust_profile }) as unknown as RunRecord;

describe("route.reasons", () => {
  it("labels group members apart and reads a deferred privileged compile as deferred, not excluded", () => {
    const row = decision(
      [
        { provider: "claude", member: "claude/model-a", eligible: false, reasons: [deferredReason] },
        { provider: "claude", member: "claude/model-b", eligible: false, reasons: [deferredReason] },
      ],
      "configured_order; privileged compile deferred to dispatch",
    );
    expect(routeReasons(ledgerWith(row), run("privileged"))).toEqual([
      "selected claude (configured_order; privileged compile deferred to dispatch)",
      "claude/model-a: compile deferred to dispatch (PROFILE_UNSUPPORTED)",
      "claude/model-b: compile deferred to dispatch (PROFILE_UNSUPPORTED)",
    ]);
  });

  it("other exclusions, and any exclusion of a non-privileged run, still read as excluded", () => {
    const row = decision(
      [
        { provider: "claude", eligible: true, reasons: [] },
        { provider: "codex", eligible: false, reasons: [{ code: "AUTH_REQUIRED" }] },
        { provider: "grok", eligible: false, reasons: [deferredReason, { code: "BINARY_MISSING" }] },
        { provider: "kimi", eligible: false, reasons: [deferredReason] },
      ],
      "configured_order",
    );
    const tail = ["claude: eligible", "codex: excluded AUTH_REQUIRED", "grok: excluded PROFILE_UNSUPPORTED"];
    expect(routeReasons(ledgerWith(row), run("privileged")).slice(1)).toEqual([
      ...tail,
      "kimi: compile deferred to dispatch (PROFILE_UNSUPPORTED)",
    ]);
    expect(routeReasons(ledgerWith(row), run("edit-untrusted")).slice(1)).toEqual([
      ...tail,
      "kimi: excluded PROFILE_UNSUPPORTED",
    ]);
  });
});
