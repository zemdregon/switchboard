/** T5.3: the pure open-work derivation of LLD §15.3 (closed item kinds, fixed order, bound, no I/O). */
import { describe, expect, it } from "vitest";
import { deriveOpenWork, OPEN_WORK_KINDS, OPEN_WORK_MAX_ITEMS, type OpenWorkRun } from "./open-work.js";

const run = (over: Partial<OpenWorkRun> & { runId: string }): OpenWorkRun => ({
  state: "SUCCEEDED",
  failureCode: null,
  verification: [],
  nestedRepositoriesSkipped: 0,
  gitPolicyViolation: false,
  ...over,
});

describe("deriveOpenWork", () => {
  it("no runs and a succeeded newest run give no open work", () => {
    expect(deriveOpenWork([])).toEqual([]);
    expect(deriveOpenWork([run({ runId: "run_1" })])).toEqual([]);
  });

  it("a failed newest run: its failure code and the not-completed instruction", () => {
    expect(deriveOpenWork([run({ runId: "run_1", state: "FAILED", failureCode: "TEST_FAILURE" })])).toEqual([
      { kind: "last_run_failed", run_id: "run_1", detail: "TEST_FAILURE" },
      { kind: "instruction_not_completed", run_id: "run_1", detail: "run_1" },
    ]);
  });

  it("a cancelled newest run has no detail", () => {
    expect(deriveOpenWork([run({ runId: "run_1", state: "CANCELLED" })])).toEqual([
      { kind: "last_run_cancelled", run_id: "run_1", detail: null },
      { kind: "instruction_not_completed", run_id: "run_1", detail: "run_1" },
    ]);
  });

  it("only the NEWEST run counts for failure; an older failed run is not open work once a later run succeeded", () => {
    expect(
      deriveOpenWork([run({ runId: "run_1", state: "FAILED", failureCode: "TOOL_FAILURE" }), run({ runId: "run_2" })]),
    ).toEqual([]);
  });

  it("verification: every non-passing command of the newest run that ran verification, with the orchestrator's argv", () => {
    const verification = [
      { index: 0, outcome: "passed", argv: ["npm", "test"] },
      { index: 1, outcome: "failed", argv: ["npm", "run", "lint"] },
      { index: 2, outcome: "not_run", argv: null },
    ];
    // The newest run that ran verification is run_1, although run_2 (no verification) is newer.
    expect(deriveOpenWork([run({ runId: "run_1", verification }), run({ runId: "run_2" })])).toEqual([
      {
        kind: "verification_not_passing",
        run_id: "run_1",
        detail: { index: 1, outcome: "failed", argv: ["npm", "run", "lint"] },
      },
      { kind: "verification_not_passing", run_id: "run_1", detail: { index: 2, outcome: "not_run", argv: null } },
    ]);
  });

  it("nested repositories (count only) and a Git policy violation of the newest run", () => {
    expect(deriveOpenWork([run({ runId: "run_1", nestedRepositoriesSkipped: 2, gitPolicyViolation: true })])).toEqual([
      { kind: "nested_repositories_skipped", run_id: "run_1", detail: 2 },
      { kind: "git_policy_violation", run_id: "run_1", detail: null },
    ]);
  });

  it("emits kinds only from the closed list, in list order", () => {
    const items = deriveOpenWork([
      run({
        runId: "run_1",
        state: "FAILED",
        failureCode: "TEST_FAILURE",
        verification: [{ index: 0, outcome: "failed", argv: ["x"] }],
        nestedRepositoriesSkipped: 1,
        gitPolicyViolation: true,
      }),
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "last_run_failed",
      "verification_not_passing",
      "instruction_not_completed",
      "nested_repositories_skipped",
      "git_policy_violation",
    ]);
    for (const i of items) expect(OPEN_WORK_KINDS).toContain(i.kind);
  });

  it("is bounded to 20 items", () => {
    const verification = Array.from({ length: 40 }, (_, index) => ({ index, outcome: "failed", argv: null }));
    expect(deriveOpenWork([run({ runId: "run_1", verification })])).toHaveLength(OPEN_WORK_MAX_ITEMS);
  });

  it("is pure: the same input gives equal output and the input is not modified", () => {
    const input = [run({ runId: "run_1", state: "FAILED", failureCode: "TOOL_FAILURE" })];
    const copy = structuredClone(input);
    expect(deriveOpenWork(input)).toEqual(deriveOpenWork(input));
    expect(input).toEqual(copy);
  });
});
