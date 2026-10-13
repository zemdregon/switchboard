/**
 * Publish ref naming (FR-GIT-08, LLD §12.3, ADR-0025). The publish ref of a meta-session is
 * `refs/heads/<prefix><sess>`. It is kept apart from the internal run branches `switchboard/<sess>/<run>` and from the
 * checkpoint commits on them: a publish commit's parent is always the previous publish commit or the session's base
 * commit, never a run-branch commit, so no checkpoint is reachable from it.
 *
 * Assumption (Delegated, ADR-0025): the LOCAL publish prefix is a controller setting, default `switchboard/pub/`. It is
 * not the context's `push.branch_prefix`, which names the REMOTE branch (LLD §12.6 pushes the publish ref to
 * `<branch_prefix><sess>`). LLD §12.3 as first written equated the two, but the §11.1 example `branch_prefix:
 * "switchboard/"` would make the local ref `refs/heads/switchboard/<sess>`, which cannot coexist with the run branch
 * `refs/heads/switchboard/<sess>/<run>` (Git cannot hold a ref and a directory of the same name).
 */

export const DEFAULT_PUBLISH_PREFIX = "switchboard/pub/";

const SESSION_ID = /^sess_[0-9A-Za-z]{1,40}$/;
const PREFIX = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+$/;

export class PublishRefError extends Error {
  override readonly name = "PublishRefError";
}

/** `refs/heads/<prefix><sess>`; throws {@link PublishRefError} for a prefix that could collide with a run branch. */
export function publishRefFor(metaSessionId: string, prefix: string = DEFAULT_PUBLISH_PREFIX): string {
  if (!SESSION_ID.test(metaSessionId)) throw new PublishRefError(`invalid meta-session id: ${metaSessionId}`);
  if (!PREFIX.test(prefix) || prefix.includes("..") || prefix.includes("//")) {
    throw new PublishRefError(`invalid publish prefix ${JSON.stringify(prefix)}`);
  }
  if (prefix.split("/").some((seg) => seg.endsWith(".lock") || seg.startsWith(".") || seg.endsWith("."))) {
    throw new PublishRefError(`invalid publish prefix ${JSON.stringify(prefix)}`);
  }
  const ref = `refs/heads/${prefix}${metaSessionId}`;
  // Anything at or under `switchboard/sess_*` is the run-branch namespace (`switchboard/<sess>/<run>`).
  if (/^refs\/heads\/switchboard\/sess_[^/]*(?:\/|$)/.test(ref)) {
    throw new PublishRefError(
      `publish prefix ${JSON.stringify(prefix)} would put the publish ref in the run-branch namespace`,
    );
  }
  return ref;
}

/** True for a ref the controller uses for run branches (`refs/heads/switchboard/<sess>/<run>`). */
export function isRunBranchRef(ref: string): boolean {
  return /^refs\/heads\/switchboard\/sess_[0-9A-Za-z]+\/run_[0-9A-Za-z]+$/.test(ref);
}
