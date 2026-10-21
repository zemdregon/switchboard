/**
 * Submodule checkpoints (ADR-0079 item 3 "Checkpoints"). A run's post-run checkpoint (`WorkspaceManager.finalize`)
 * also checkpoints each changed writable submodule worktree in its store and records the new gitlink in the umbrella
 * checkpoint, so a continued meta-session starts with its submodule edits. Changes in a read-only submodule (a wiki
 * included) are not carried (`submodule_changes_skipped` warning).
 *
 * The workspace manager wires it around its own checkpoint commit:
 *
 * 1. {@link checkpointSubmodules} before the umbrella's `add -A`: per attached path whose `.git` link verifies, the
 *    worktree's tree is written through a temporary index in its store against the worktree's `HEAD` (nested
 *    repositories and the run's skill paths excluded; the store's filters and hooks never run). A changed writable
 *    path gets a detached commit with the controller identity (`commit-tree`, parent `HEAD`), kept by
 *    `refs/switchboard/checkpoints/<run>/<sha>` in the store, and the worktree's `HEAD` and index move to it
 *    (`reset --mixed`: the files are untouched). The result's `gitlinks` holds, for every writable path whose
 *    checkpointed `HEAD` differs from the umbrella `HEAD`'s gitlink, the commit to record.
 * 2. {@link applyCheckpointGitlinks} after the umbrella's `add -A` and before its commit: `update-index --index-info`
 *    sets those gitlinks in the umbrella worktree's own index (the scan scope keeps excluding the submodule paths, so
 *    the manager's "anything staged" check must also count a non-empty `gitlinks`).
 * 3. {@link checkpointSkippedEventPayload}: the `submodule_changes_skipped` run event for the skipped paths.
 *
 * A path whose link does not verify is never used (`link_invalid`): no Git call runs in it and its gitlink stays.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { CONTROLLER_IDENTITY, git, gitText } from "../workspace/git.js";
import { excludePathspec } from "../workspace/nested.js";
import { isFullSha } from "./errors.js";
import { type AttachedSubmodule, type AttachRecord, verifySubmoduleLink, writeWorktreeTree } from "./worktree.js";

/** Run event: changed submodule paths a checkpoint did not carry (read-only, or a link that does not verify). */
export const SUBMODULE_CHANGES_SKIPPED_EVENT = "submodule_changes_skipped";

/** Prefix of the store refs that keep submodule checkpoint commits. */
export const SUBMODULE_CHECKPOINT_REF_PREFIX = "refs/switchboard/checkpoints/";

const WORKTREE_CONFIG = ["-c", "submodule.recurse=false"] as const;

export interface SubmoduleCheckpoint {
  readonly path: string;
  readonly key: string;
  readonly parentSha: string;
  readonly commitSha: string;
  /** The store ref that keeps it. */
  readonly ref: string;
}

export interface SubmoduleCheckpointResult {
  /** Attached path → gitlink to record in the umbrella checkpoint (only where it differs from the umbrella `HEAD`). */
  readonly gitlinks: ReadonlyMap<string, string>;
  readonly checkpoints: readonly SubmoduleCheckpoint[];
  /** Changed paths not carried (`read_only`), and paths whose link does not verify (`link_invalid`). */
  readonly skipped: readonly { readonly path: string; readonly reason: "read_only" | "link_invalid" }[];
}

/** Step 1. Git failures propagate (the caller's checkpoint fails as it would for the umbrella). */
export async function checkpointSubmodules(input: {
  readonly runId: string;
  readonly runWorktree: string;
  readonly record: AttachRecord;
  /** The umbrella worktree's `HEAD` before its checkpoint commit (whose gitlinks are compared). */
  readonly umbrellaHead: string;
  /** The run's recorded native skill paths (umbrella-relative). */
  readonly skillPaths?: readonly string[];
  readonly scratchDir?: string;
  readonly now?: () => Date;
}): Promise<SubmoduleCheckpointResult> {
  if (!/^run_[0-9A-Z]{26}$/u.test(input.runId)) throw new TypeError("invalid run id");
  const umbrellaLinks = await gitlinksAt(
    input.runWorktree,
    input.umbrellaHead,
    input.record.entries.map((e) => e.path),
  );
  const gitlinks = new Map<string, string>();
  const checkpoints: SubmoduleCheckpoint[] = [];
  const skipped: { path: string; reason: "read_only" | "link_invalid" }[] = [];
  const when = Math.floor((input.now ?? (() => new Date()))().getTime() / 1000);
  const identityEnv = {
    GIT_AUTHOR_NAME: CONTROLLER_IDENTITY.name,
    GIT_AUTHOR_EMAIL: CONTROLLER_IDENTITY.email,
    GIT_AUTHOR_DATE: `${when} +0000`,
    GIT_COMMITTER_NAME: CONTROLLER_IDENTITY.name,
    GIT_COMMITTER_EMAIL: CONTROLLER_IDENTITY.email,
    GIT_COMMITTER_DATE: `${when} +0000`,
  };
  for (const e of input.record.entries) {
    if (!(await verifySubmoduleLink(input.runWorktree, e))) {
      skipped.push({ path: e.path, reason: "link_invalid" });
      continue;
    }
    const cwd = path.join(await realpath(input.runWorktree), e.path);
    const head = await gitText([...WORKTREE_CONFIG, "rev-parse", "--verify", "HEAD^{commit}"], { cwd });
    const headTree = await gitText([...WORKTREE_CONFIG, "rev-parse", "--verify", `${head}^{tree}`], { cwd });
    const skill = (input.skillPaths ?? [])
      .filter((p) => p.startsWith(`${e.path}/`))
      .map((p) => excludePathspec(p.slice(e.path.length + 1)));
    const tree = await writeWorktreeTree(input.runWorktree, e, head, {
      excludes: skill,
      ...(input.scratchDir !== undefined ? { scratchDir: input.scratchDir } : {}),
    });
    if (!e.writable) {
      if (tree !== headTree) skipped.push({ path: e.path, reason: "read_only" });
      continue;
    }
    let tip = head;
    if (tree !== headTree) {
      tip = await commitCheckpoint(e, tree, head, input.runId, identityEnv);
      const ref = `${SUBMODULE_CHECKPOINT_REF_PREFIX}${input.runId}/${tip}`;
      await git([...WORKTREE_CONFIG, "update-ref", ref, tip, "0".repeat(tip.length)], { cwd: e.store });
      // HEAD and index follow the checkpoint; the files are already its tree.
      await git([...WORKTREE_CONFIG, "reset", "-q", "--mixed", tip], { cwd });
      checkpoints.push({ path: e.path, key: e.key, parentSha: head, commitSha: tip, ref });
    }
    if (umbrellaLinks.get(e.path) !== tip) gitlinks.set(e.path, tip);
  }
  return { gitlinks, checkpoints, skipped };
}

/** Step 2: set `gitlinks` in the index of the umbrella worktree at `cwd` (its own index, as its checkpoint uses). */
export async function applyCheckpointGitlinks(cwd: string, gitlinks: ReadonlyMap<string, string>): Promise<void> {
  if (gitlinks.size === 0) return;
  let info = "";
  for (const [p, sha] of gitlinks) {
    if (!isFullSha(sha)) throw new TypeError("a gitlink must be a full object id");
    info += `160000 ${sha}\t${p}\n`;
  }
  await git(["update-index", "--index-info"], { cwd, input: info });
}

/** Step 3: the bounded `submodule_changes_skipped` payload (paths and reason codes only), or undefined. */
export function checkpointSkippedEventPayload(result: SubmoduleCheckpointResult): Record<string, unknown> | undefined {
  if (result.skipped.length === 0) return undefined;
  return { stage: "checkpoint", paths: result.skipped.map((s) => ({ path: s.path, reason: s.reason })) };
}

async function commitCheckpoint(
  e: AttachedSubmodule,
  tree: string,
  parent: string,
  runId: string,
  identityEnv: Readonly<Record<string, string>>,
): Promise<string> {
  const out = await git([...WORKTREE_CONFIG, "commit-tree", tree, "-p", parent, "-F", "-"], {
    cwd: e.store,
    input: `switchboard: checkpoint for ${runId}\n`,
    env: identityEnv,
  });
  return out.stdout.toString("utf8").trim();
}

async function gitlinksAt(cwd: string, commit: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 256) {
    const r = await git(
      ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", ...paths.slice(i, i + 256)],
      {
        cwd,
      },
    );
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (rec === "") continue;
      const tab = rec.indexOf("\t");
      const [mode, , sha] = rec.slice(0, tab).split(" ");
      if (mode === "160000" && sha !== undefined) out.set(rec.slice(tab + 1), sha);
    }
  }
  return out;
}
