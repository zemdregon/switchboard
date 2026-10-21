/**
 * The ordered merge (ADR-0080 item 7, LLD §3.4.17) through the policy poller and the hook: linked submodule pull
 * requests in path order through the gate's checks and G12 pinned to the pushed head, G19 merge commits recorded, one
 * gitlinks-only repoint commit on the published umbrella tip (provenance row, secret scan, fast-forward push through the
 * controller pusher), then the umbrella gate at the new head with verification read at the pre-repoint tip. Local
 * fixture repositories and a fake GitHub only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { g } from "../submodules/fixtures/repos.js";
import { insertSubmodulePullRequest, insertSubmodulePush } from "../submodules/ledger.js";
import { type FakePr, makeWorld, PROJECT, UMBRELLA_GH, type World } from "./fixtures/submodule-merge.js";
import { type LinkedMergeHook, type MergePolicyDeps, mergeOnRequest, pollMergePolicies } from "./merge-policy.js";
import {
  hasLinkedPullRequests,
  linkedRepositories,
  type SubmoduleMergeDeps,
  submoduleMergeHook,
} from "./submodule-merge.js";

let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

function deps(world: World, sub: SubmoduleMergeDeps | undefined = world.sub()): MergePolicyDeps {
  const base = {
    db: world.db,
    ledger: world.ledger,
    merge: world.gh,
    targets: world.targets,
    nowMs: () => Date.now(),
  };
  return {
    ...base,
    resolveRemote: async () => UMBRELLA_GH,
    linkedMerge: submoduleMergeHook(base, sub),
  };
}

const pr = (world: World, repo: string) => world.gh.prs.get(repo) as FakePr;
const lsTree = (dir: string, rev: string) => g(dir, "ls-tree", rev, "--", "libs/a", "libs/b", "vendor/a");
const linkOf = (dir: string, rev: string, p: string) => g(dir, "rev-parse", `${rev}:${p}`);

describe("ordered merge (ADR-0080 item 7)", () => {
  it("lists the linked repositories in path order with their duplicate paths", async () => {
    w = await makeWorld();
    const repos = linkedRepositories(w.db, PROJECT, w.publishRef);
    expect(repos.map((r) => [r.repo, r.paths, r.pr.number])).toEqual([
      ["acme/liba", ["libs/a", "vendor/a"], 11],
      ["acme/libb", ["libs/b"], 12],
    ]);
    expect(hasLinkedPullRequests(w.db, "other", w.publishRef)).toBe(false);
    expect(hasLinkedPullRequests(w.db, PROJECT, "refs/heads/sb/none")).toBe(false);
  });

  it("happy path: both submodule PRs squash-merged in path order, one repoint commit pushed, umbrella merged", async () => {
    w = await makeWorld();
    w.verify();
    const res = await pollMergePolicies(deps(w));
    expect(res.refused).toEqual([]);
    expect(res.merged).toHaveLength(1);
    const tip = w.remoteTip();
    expect(res.merged[0]).toMatchObject({ projectId: PROJECT, publishRef: w.publishRef, prNumber: 42, headSha: tip });
    // Path order, each pinned to its pushed head, then the umbrella pinned to the repoint commit.
    expect(w.gh.merges).toEqual([
      { repo: "acme/liba", prNumber: 11, method: "squash", headSha: w.libs.a.head1 },
      { repo: "acme/libb", prNumber: 12, method: "squash", headSha: w.libs.b.head1 },
      { repo: "acme/umbrella", prNumber: 42, method: "squash", headSha: tip },
    ]);
    const mergedA = pr(w, "acme/liba").mergeCommitSha as string;
    const mergedB = pr(w, "acme/libb").mergeCommitSha as string;
    expect(mergedA).not.toBe(w.libs.a.head1); // a squash merge is a new SHA
    // The repoint commit: one parent (the published tip), gitlinks only, duplicate paths together.
    expect(g(w.bare, "rev-parse", `${tip}^@`)).toBe(w.preTip);
    expect(g(w.bare, "diff-tree", "-r", "--name-only", "--no-commit-id", w.preTip, tip).split("\n").sort()).toEqual([
      "libs/a",
      "libs/b",
      "vendor/a",
    ]);
    expect(linkOf(w.bare, tip, "libs/a")).toBe(mergedA);
    expect(linkOf(w.bare, tip, "vendor/a")).toBe(mergedA);
    expect(linkOf(w.bare, tip, "libs/b")).toBe(mergedB);
    expect(lsTree(w.bare, tip)).toContain("160000 commit");
    expect(g(w.bare, "log", "-1", "--format=%an <%ae>", tip)).toBe("Ada Maintainer <ada@example.test>");
    // The local publish ref moved with it, and the merge commits are in their stores.
    expect(g(w.umbrella, "rev-parse", `refs/heads/switchboard/pub/${w.sessionId}`)).toBe(tip);
    const store = (k: string) => `${w?.fx.settings.cloneRoot}/github.test/acme/${k}`;
    expect(g(store("liba"), "cat-file", "-t", mergedA)).toBe("commit");
    expect(g(store("libb"), "cat-file", "-t", mergedB)).toBe("commit");
    // Steps persisted, a provenance row and an accepted push of the repoint commit.
    expect(w.steps().map((s) => [s.step, s.repo, s.head_sha, s.merged_sha])).toEqual([
      ["submodule_merged", "acme/liba", w.libs.a.head1, mergedA],
      ["submodule_merged", "acme/libb", w.libs.b.head1, mergedB],
      ["gitlinks_repointed", null, w.preTip, tip],
    ]);
    const gc = w.db
      .prepare(
        "SELECT c.origin, c.run_id, e.payload_json FROM git_commit c JOIN run_event e ON e.id = c.tool_event_id WHERE c.commit_sha = ?",
      )
      .get(tip) as { origin: string; run_id: string; payload_json: string };
    expect(gc).toMatchObject({ origin: "finalize_only", run_id: w.runId });
    expect(JSON.parse(gc.payload_json)).toMatchObject({
      via: "submodule_repoint",
      parent_sha: w.preTip,
      files_changed: 3,
    });
    const push = w.db
      .prepare("SELECT outcome, head_sha, run_id, requested_by FROM git_push WHERE head_sha = ?")
      .get(tip);
    expect(push).toEqual({ outcome: "ACCEPTED", head_sha: tip, run_id: w.runId, requested_by: "mcp_client:steward" });
    // The umbrella merge_event is keyed to the new head; ref_event run events for the steps.
    const events = w.db
      .prepare("SELECT payload_json FROM run_event WHERE run_id = ? AND type = 'ref_event' ORDER BY ts, id")
      .all(w.runId)
      .map((r) => JSON.parse((r as { payload_json: string }).payload_json).kind);
    expect(events).toEqual(["submodule_merged", "submodule_merged", "gitlinks_repointed"]);
    // A second pass has nothing left to do.
    const again = await pollMergePolicies(deps(w));
    expect(again.merged).toEqual([]);
  });

  it("a pending check on a submodule PR is recorded once and the walk stops; the next pass resumes", async () => {
    w = await makeWorld();
    w.verify();
    pr(w, "acme/libb").checks = { kind: "checks", buckets: ["pass", "pending"] };
    const first = await pollMergePolicies(deps(w));
    expect(first.merged).toEqual([]);
    expect(first.refused).toEqual([
      { projectId: PROJECT, publishRef: w.publishRef, headSha: w.preTip, reason: "check_pending", recorded: true },
    ]);
    expect(w.gh.merges.map((m) => m.repo)).toEqual(["acme/liba"]);
    const second = await pollMergePolicies(deps(w));
    expect(second.refused[0]).toMatchObject({ reason: "check_pending", recorded: false });
    expect(w.steps().map((s) => [s.step, s.repo, s.reason])).toEqual([
      ["submodule_merged", "acme/liba", null],
      ["submodule_refused", "acme/libb", "check_pending"],
    ]);
    // liba is not merged again; libb's checks pass now.
    pr(w, "acme/libb").checks = { kind: "checks", buckets: ["pass"] };
    const third = await pollMergePolicies(deps(w));
    expect(third.merged).toHaveLength(1);
    expect(w.gh.merges.map((m) => m.repo)).toEqual(["acme/liba", "acme/libb", "acme/umbrella"]);
  });

  it("a refusal is recorded once per repository, head and reason, with its submodule_merge view", async () => {
    w = await makeWorld();
    w.verify();
    pr(w, "acme/liba").isDraft = true;
    const d = deps(w);
    const hook = d.linkedMerge as LinkedMergeHook;
    const ref = { remote: "origin", publishRef: w.publishRef, headSha: w.preTip };
    const target = w.targets()[0] as ReturnType<World["targets"]>[number];
    const one = await hook(target, ref, UMBRELLA_GH, { mode: "request" });
    const two = await hook(target, ref, UMBRELLA_GH, { mode: "request" });
    expect(one).toMatchObject({ kind: "refused", reason: "draft", recorded: true });
    expect(two).toMatchObject({ kind: "refused", reason: "draft", recorded: false });
    expect(one?.submoduleMerge).toEqual({
      phase: "submodules",
      repos: [
        { repo: "acme/liba", paths: ["libs/a", "vendor/a"], pr_number: 11, state: "refused", reason: "draft" },
        { repo: "acme/libb", paths: ["libs/b"], pr_number: 12, state: "waiting" },
      ],
    });
    expect(w.steps().filter((s) => s.step === "submodule_refused")).toHaveLength(1);
    expect(w.gh.merges).toEqual([]);
  });

  it("accepts a submodule PR a person already merged at the pushed head, with its merge commit", async () => {
    w = await makeWorld();
    w.verify();
    const byHand = w.gh.mergeOnRemote("acme/liba");
    const res = await pollMergePolicies(deps(w));
    expect(res.merged).toHaveLength(1);
    expect(w.gh.merges.map((m) => m.repo)).toEqual(["acme/libb", "acme/umbrella"]);
    expect(w.steps()[0]).toMatchObject({ step: "submodule_merged", repo: "acme/liba", merged_sha: byHand });
    expect(linkOf(w.bare, w.remoteTip(), "vendor/a")).toBe(byHand);
  });

  it("a merged PR whose head is not the pushed head is head_moved", async () => {
    w = await makeWorld();
    w.verify();
    g(w.libs.a.dir, "checkout", "-q", `sb/${w.sessionId}`);
    g(w.libs.a.dir, "commit", "-q", "--allow-empty", "-m", "foreign");
    g(w.libs.a.dir, "checkout", "-q", "main");
    w.gh.mergeOnRemote("acme/liba");
    const res = await pollMergePolicies(deps(w));
    expect(res.refused[0]).toMatchObject({ reason: "head_moved" });
    expect(w.steps().map((s) => s.step)).toEqual(["submodule_refused"]);
  });

  it("resumes after a restart at the right phase, without a second repoint commit", async () => {
    w = await makeWorld();
    w.verify();
    pr(w, "acme/umbrella").checks = { kind: "checks", buckets: ["pending"] };
    const first = await pollMergePolicies(deps(w));
    expect(first.refused[0]).toMatchObject({ reason: "check_pending" });
    const tip = w.remoteTip();
    expect(tip).not.toBe(w.preTip);
    w.reopen();
    pr(w, "acme/umbrella").checks = { kind: "checks", buckets: ["pass"] };
    const d = deps(w);
    const out = await mergeOnRequest(
      { ...d, ledger: w.ledger },
      {
        projectId: PROJECT,
        remote: "origin",
        publishRef: w.publishRef,
        expectedHeadSha: w.preTip,
        requestedBy: "mcp_client:steward",
      },
    );
    expect(out).toMatchObject({ kind: "merged", headSha: tip, submoduleMerge: { phase: "merged" } });
    expect(w.steps().filter((s) => s.step === "gitlinks_repointed")).toHaveLength(1);
    expect(w.db.prepare("SELECT count(*) AS n FROM git_push WHERE outcome = 'ACCEPTED'").get()).toEqual({ n: 2 });
  });

  it("refuses a repoint push that would not fast-forward; nothing is forced", async () => {
    w = await makeWorld();
    w.verify();
    // Someone pushes onto the umbrella pull request branch after the umbrella pre-check and the submodule merges (the
    // repoint scan runs right before the push).
    const world = w;
    let foreign = "";
    const racing = w.sub({
      scan: async () => {
        foreign = g(world.umbrella, "commit-tree", `${world.preTip}^{tree}`, "-p", world.preTip, "-m", "foreign");
        g(world.umbrella, "push", "-q", "origin", `${foreign}:${world.publishRef}`);
        return { hits: [], hitCount: 0, allowedCount: 0, binaryPaths: [], binaryCount: 0 };
      },
    });
    const res = await pollMergePolicies(deps(w, racing));
    expect(res.refused[0]).toMatchObject({ reason: "repoint_not_fast_forward", recorded: false });
    expect(w.remoteTip()).toBe(foreign);
    expect(w.steps().map((s) => s.step)).toEqual(["submodule_merged", "submodule_merged"]);
    const rejected = w.db.prepare("SELECT outcome, detail FROM git_push WHERE outcome != 'ACCEPTED'").all();
    expect(rejected).toEqual([{ outcome: "REJECTED_REMOTE", detail: "NON_FAST_FORWARD" }]);
    expect(w.gh.merges.map((m) => m.repo)).toEqual(["acme/liba", "acme/libb"]);
  });

  it("secret-scans the repoint range (gitlinks only, so no finding) and a finding would refuse", async () => {
    w = await makeWorld();
    w.verify();
    const ranges: [string, string][] = [];
    const clean = w.sub({
      scan: async (_repo, from, head) => {
        ranges.push([from, head]);
        return { hits: [], hitCount: 0, allowedCount: 0, binaryPaths: [], binaryCount: 0 };
      },
    });
    const res = await pollMergePolicies(deps(w, clean));
    expect(res.merged).toHaveLength(1);
    expect(ranges).toEqual([[w.preTip, w.remoteTip()]]);
    // The pusher scanned again before the push (every push is scanned).
    const ev = w.db
      .prepare("SELECT payload_json FROM run_event WHERE type = 'git_push' ORDER BY ts DESC, id DESC LIMIT 1")
      .get() as { payload_json: string };
    expect(JSON.parse(ev.payload_json).secret_scan).toMatchObject({ hit_count: 0 });

    const v = await makeWorld();
    try {
      v.verify();
      const dirty = v.sub({
        scan: async () => ({
          hits: [{ rule_id: "aws-access-key", path: "x", line: 1 }],
          hitCount: 1,
          allowedCount: 0,
          binaryPaths: [],
          binaryCount: 0,
        }),
      });
      const blocked = await pollMergePolicies(deps(v, dirty));
      expect(blocked.refused[0]).toMatchObject({ reason: "secret_scan_blocked" });
      expect(v.remoteTip()).toBe(v.preTip);
    } finally {
      v.close();
    }
  });

  it("applies merge_policy.checks all_reported to submodule PRs (G18; none reported refuses)", async () => {
    w = await makeWorld({ policy: { checks: "all_reported" } });
    w.verify();
    pr(w, "acme/liba").reported = { kind: "none" };
    const first = await pollMergePolicies(deps(w));
    expect(first.refused[0]).toMatchObject({ reason: "no_checks_reported" });
    expect(w.gh.calls).toContain("reported acme/liba");
    expect(w.gh.calls.some((c) => c.startsWith("checks "))).toBe(false);
    pr(w, "acme/liba").reported = { kind: "checks", buckets: ["pass", "pass"] };
    const second = await pollMergePolicies(deps(w));
    expect(second.merged).toHaveLength(1);
    expect(w.gh.calls.some((c) => c.startsWith("checks "))).toBe(false);
  });

  it("a failed G12 of a submodule PR is merge_failed; the poller does not retry that head, a request does", async () => {
    w = await makeWorld();
    w.verify();
    w.gh.failMerge.add("acme/liba");
    expect((await pollMergePolicies(deps(w))).refused[0]).toMatchObject({ reason: "merge_failed", recorded: true });
    w.gh.failMerge.clear();
    const skipped = await pollMergePolicies(deps(w));
    expect(skipped.refused).toEqual([]);
    expect(skipped.merged).toEqual([]);
    const out = await mergeOnRequest(
      { ...deps(w), ledger: w.ledger },
      {
        projectId: PROJECT,
        remote: "origin",
        publishRef: w.publishRef,
      },
    );
    expect(out.kind).toBe("merged");
  });

  it("fails closed when linked rows exist but one or all of them do not parse", async () => {
    w = await makeWorld();
    w.verify();
    const d = deps(w);
    const hook = d.linkedMerge as LinkedMergeHook;
    const target = w.targets()[0] as ReturnType<World["targets"]>[number];
    const badRow = (umbrellaRef: string, repo: string) => {
      const world = w as World;
      const push = insertSubmodulePush(world.db, {
        runId: world.runId,
        metaSessionId: world.sessionId,
        projectId: PROJECT,
        repo: "github.test/acme/libc",
        paths: ["libs/c"],
        ref: umbrellaRef,
        headSha: world.libs.a.head1,
        umbrellaHeadSha: world.preTip,
        outcome: "ACCEPTED",
        reason: "ok",
        requestedBy: "mcp_client:steward",
      });
      insertSubmodulePullRequest(world.db, {
        runId: world.runId,
        metaSessionId: world.sessionId,
        pushId: push.id,
        clientId: "steward",
        repo,
        number: 13,
        url: "https://github.com/acme/libc/pull/13",
        branch: `sb/${world.sessionId}`,
        baseRef: "main",
        headSha: world.libs.a.head1,
        umbrellaRef,
        draft: false,
        action: "created",
      });
    };
    // A ref whose only linked row does not parse: never the plain gate (that would merge without a repoint).
    const other = "refs/heads/sb/other";
    badRow(other, "acme/libc/extra");
    const ref = { remote: "origin", publishRef: other, headSha: w.preTip };
    expect(await hook(target, ref, UMBRELLA_GH, { mode: "request" })).toMatchObject({
      kind: "refused",
      reason: "submodule_merge_unavailable",
    });
    // One unparsable row beside valid ones refuses the whole ordered merge.
    badRow(w.publishRef, "not a repo");
    const res = await pollMergePolicies(d);
    expect(res.refused).toEqual([
      {
        projectId: PROJECT,
        publishRef: w.publishRef,
        headSha: w.preTip,
        reason: "submodule_merge_unavailable",
        recorded: false,
      },
    ]);
    expect(w.gh.calls).toEqual([]);
    expect(w.gh.merges).toEqual([]);
    expect(w.remoteTip()).toBe(w.preTip);
  });

  it("fails closed without the submodule merge inputs or without the hook", async () => {
    w = await makeWorld();
    w.verify();
    const base = { db: w.db, ledger: w.ledger, merge: w.gh, targets: w.targets };
    const noInputs = await pollMergePolicies({
      ...base,
      resolveRemote: async () => UMBRELLA_GH,
      linkedMerge: submoduleMergeHook(base, undefined),
    });
    expect(noInputs.refused[0]).toMatchObject({ reason: "submodule_merge_unavailable" });
    const noHook = await pollMergePolicies({ ...base, resolveRemote: async () => UMBRELLA_GH });
    expect(noHook).toMatchObject({ merged: [], refused: [] });
    const request = await mergeOnRequest(
      { ...base, resolveRemote: async () => UMBRELLA_GH },
      { projectId: PROJECT, remote: "origin", publishRef: w.publishRef },
    );
    expect(request).toMatchObject({ kind: "refused", reason: "submodule_merge_unavailable" });
    expect(w.gh.calls).toEqual([]);
    expect(w.remoteTip()).toBe(w.preTip);
  });
});

describe("umbrella pre-check before any submodule merge (ADR-0080 item 7 step 0)", () => {
  const request = (world: World, sub?: SubmoduleMergeDeps) =>
    mergeOnRequest(
      { ...deps(world, sub), ledger: world.ledger },
      { projectId: PROJECT, remote: "origin", publishRef: world.publishRef, requestedBy: "mcp_client:steward" },
    );
  const noSubmoduleWrite = (world: World) => {
    expect(world.gh.merges).toEqual([]);
    expect(world.gh.calls.filter((c) => c !== "view acme/umbrella")).toEqual([]);
    expect(world.steps()).toEqual([]);
    expect(world.remoteTip()).toBe(world.preTip);
  };
  const umbrellaRefusals = (world: World) =>
    world.db
      .prepare("SELECT head_sha, reason FROM merge_event WHERE publish_ref = ? AND outcome = 'refused'")
      .all(world.publishRef);

  it("an unverified run is refused unverified_at_head before any submodule G12 (poll and request)", async () => {
    w = await makeWorld();
    const polled = await pollMergePolicies(deps(w));
    expect(polled.merged).toEqual([]);
    expect(polled.refused).toEqual([
      { projectId: PROJECT, publishRef: w.publishRef, headSha: w.preTip, reason: "unverified_at_head", recorded: true },
    ]);
    const out = await request(w);
    expect(out).toMatchObject({
      kind: "refused",
      reason: "unverified_at_head",
      prNumber: 42,
      submoduleMerge: {
        phase: "submodules",
        repos: [
          { repo: "acme/liba", state: "waiting" },
          { repo: "acme/libb", state: "waiting" },
        ],
      },
    });
    noSubmoduleWrite(w);
    expect(umbrellaRefusals(w)).toEqual([{ head_sha: w.preTip, reason: "unverified_at_head" }]);
    // A verification at another commit (the repoint commit is never verified) does not count.
    w.verify("b".repeat(40));
    expect(await request(w)).toMatchObject({ kind: "refused", reason: "unverified_at_head" });
    noSubmoduleWrite(w);
  });

  it("a missing required report is refused report_missing before any submodule G12", async () => {
    w = await makeWorld({ policy: { requiredReports: ["docs-alignment"] } });
    w.verify();
    expect(await request(w)).toMatchObject({ kind: "refused", reason: "report_missing" });
    noSubmoduleWrite(w);
    w.ledger.appendRunEvent({
      runId: w.runId,
      type: "docs_alignment",
      payload: { present: true, valid: true, verdict: "aligned", head_sha: w.preTip },
    });
    expect(await request(w)).toMatchObject({ kind: "merged" });
  });

  it("a draft, closed or moved umbrella pull request is refused with the gate's reason before any submodule G12", async () => {
    for (const c of ["draft", "closed", "moved", "missing"] as const) {
      const world = await makeWorld();
      try {
        world.verify();
        const umb = world.gh.prs.get("acme/umbrella") as FakePr;
        if (c === "draft") umb.isDraft = true;
        if (c === "closed") umb.state = "CLOSED";
        if (c === "moved") {
          const foreign = g(world.umbrella, "commit-tree", `${world.preTip}^{tree}`, "-p", world.preTip, "-m", "x");
          g(world.umbrella, "push", "-q", "origin", `${foreign}:${world.publishRef}`);
        }
        if (c === "missing") world.gh.prs.delete("acme/umbrella");
        const want = { draft: "draft", closed: "not_mergeable", moved: "head_moved", missing: "not_mergeable" }[c];
        expect(await request(world)).toMatchObject({ kind: "refused", reason: want });
        // The poller: a draft or moved head is refused; no pull request or a closed one is nothing to decide.
        const polled = await pollMergePolicies(deps(world));
        expect(polled.merged).toEqual([]);
        expect(polled.refused.map((r) => r.reason)).toEqual(c === "draft" || c === "moved" ? [want] : []);
        expect(world.gh.merges).toEqual([]);
        expect(world.steps()).toEqual([]);
      } finally {
        world.close();
      }
    }
  });

  it("a superseded umbrella ref is refused head_moved by the hook itself", async () => {
    w = await makeWorld();
    w.verify();
    w.db
      .prepare(
        `INSERT INTO ci_trigger_ref_state (project_id, publish_ref, consecutive_fixes, stuck, updated_at, superseded_by)
         VALUES (?, ?, 0, 0, ?, 'pwi_newer')`,
      )
      .run(PROJECT, w.publishRef, new Date().toISOString());
    const hook = deps(w).linkedMerge as LinkedMergeHook;
    const target = w.targets()[0] as ReturnType<World["targets"]>[number];
    const ref = { remote: "origin", publishRef: w.publishRef, headSha: w.preTip };
    expect(await hook(target, ref, UMBRELLA_GH, { mode: "request" })).toMatchObject({
      kind: "refused",
      reason: "head_moved",
    });
    expect(w.gh.calls).toEqual([]);
    expect(w.steps()).toEqual([]);
  });

  it("an umbrella refused after some submodules merged stops the walk before the next submodule G12", async () => {
    w = await makeWorld();
    w.verify();
    pr(w, "acme/libb").checks = { kind: "checks", buckets: ["pending"] };
    expect(await request(w)).toMatchObject({ kind: "refused", reason: "check_pending" });
    expect(w.gh.merges.map((m) => m.repo)).toEqual(["acme/liba"]);
    pr(w, "acme/libb").checks = { kind: "checks", buckets: ["pass"] };
    (w.gh.prs.get("acme/umbrella") as FakePr).isDraft = true;
    expect(await request(w)).toMatchObject({
      kind: "refused",
      reason: "draft",
      submoduleMerge: {
        phase: "submodules",
        repos: [
          { repo: "acme/liba", state: "merged" },
          { repo: "acme/libb", state: "waiting" },
        ],
      },
    });
    expect(w.gh.merges.map((m) => m.repo)).toEqual(["acme/liba"]);
  });
});
