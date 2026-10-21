/**
 * Decision logic of the finalize-only commit (T9.7, FR-GIT-09) with a stub publisher: the two size limits skip a normal
 * run and are loosened for an approved bypass run only (owner decision 44, ROADMAP Q-45).
 */
import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../policy/index.js";
import type { CommitInput, CommitResult, GitPublisher } from "./commit.js";
import { FINALIZE_MESSAGE_MAX, type FinalizeCommitRequest, makeFinalizeCommit } from "./finalize.js";

const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "trusted-development",
  writable: true,
  identity: { name: "Ada Maintainer", email: "ada@example.test" },
  push: { policy: "branch" },
  finalize_commit: true,
};

function stub(): { publisher: GitPublisher; calls: CommitInput[] } {
  const calls: CommitInput[] = [];
  const publisher = {
    async commit(input: CommitInput): Promise<CommitResult> {
      calls.push(input);
      return { sha: "a".repeat(40), provenanceId: "gcm_1", filesChanged: input.paths?.length ?? 0 } as CommitResult;
    },
    // ADR-0080 item 4: no attached submodules here.
    async hasAttachedSubmodules(): Promise<boolean> {
      return false;
    },
  } as unknown as GitPublisher;
  return { publisher, calls };
}

const req = (over: Partial<FinalizeCommitRequest> = {}): FinalizeCommitRequest => ({
  runId: "run_1",
  project: PROJECT,
  succeeded: true,
  gitPolicyViolation: false,
  changedPaths: ["a.txt"],
  summary: "Do the thing",
  nativeSessionIds: [],
  finalizingEventId: "evt_1",
  ...over,
});
const many = Array.from({ length: 300 }, (_, i) => `f${i}.txt`);
const long = "x".repeat(20_000);

describe("makeFinalizeCommit size limits", () => {
  it("non-bypass: more than 256 paths and a summary over the limit still skip with the same reasons", async () => {
    const { publisher, calls } = stub();
    expect(await makeFinalizeCommit(publisher, req({ changedPaths: many }))).toEqual({
      outcome: "skipped",
      reason: "too_many_paths",
    });
    expect(await makeFinalizeCommit(publisher, req({ summary: long }))).toEqual({
      outcome: "skipped",
      reason: "message_too_long",
    });
    expect(await makeFinalizeCommit(publisher, req({ changedPaths: many, approvedBypass: false }))).toEqual({
      outcome: "skipped",
      reason: "too_many_paths",
    });
    expect(calls).toEqual([]);
  });

  it("approved bypass: commits all 300 paths and passes the whole summary, flagged as loosened", async () => {
    const { publisher, calls } = stub();
    const r = await makeFinalizeCommit(publisher, req({ changedPaths: many, summary: long, approvedBypass: true }));
    expect(r).toMatchObject({ outcome: "committed", filesChanged: 300 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.paths).toHaveLength(300);
    expect(calls[0]?.message).toBe(long); // untouched here: the publisher sanitises first, then truncates
    expect(calls[0]).toMatchObject({ origin: "finalize_only", looseLimits: true });
  });

  it("a normal run's commit never carries the loosening flag", async () => {
    const { publisher, calls } = stub();
    await makeFinalizeCommit(publisher, req());
    expect(calls[0]?.looseLimits).toBeUndefined();
    expect(FINALIZE_MESSAGE_MAX).toBe(8192);
  });

  it("approved bypass keeps every other skip: no changes, no message, violation, not succeeded", async () => {
    const { publisher } = stub();
    const b = { approvedBypass: true };
    expect(await makeFinalizeCommit(publisher, req({ ...b, changedPaths: [] }))).toEqual({
      outcome: "skipped",
      reason: "no_changes",
    });
    expect(await makeFinalizeCommit(publisher, req({ ...b, summary: "  " }))).toEqual({
      outcome: "skipped",
      reason: "no_message",
    });
    expect(await makeFinalizeCommit(publisher, req({ ...b, gitPolicyViolation: true }))).toEqual({
      outcome: "skipped",
      reason: "git_policy_violation",
    });
    expect(await makeFinalizeCommit(publisher, req({ ...b, succeeded: false }))).toEqual({
      outcome: "skipped",
      reason: "run_not_succeeded",
    });
  });
});
