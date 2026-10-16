/**
 * Published-ref allowlist for the CI-failure trigger (T15.3; FR-QUE-03, LLD §18.6 "Published branch"). A ref is polled
 * only when Switchboard itself pushed it for this project: an `ACCEPTED` `git_push` row (LLD §12.3) whose `project_id`
 * matches and whose target is `refs/heads/*`. The tip is the SHA of the latest accepted push of that ref, so a commit
 * someone else pushed on top is out of scope until Switchboard publishes it.
 */
import type Database from "better-sqlite3";
import { isRemoteName } from "../git/push-names.js";
import { gitText } from "../workspace/git.js";
import { branchOfPublishRef, isFullLowerSha, isGhOwner, isGhRepo } from "./gh-argv.js";

export interface PublishedRef {
  /** Remote NAME the push went to (never a URL). */
  readonly remote: string;
  /** `refs/heads/<branch>`. */
  readonly publishRef: string;
  readonly headSha: string;
}

/** Every `refs/heads/*` ref Switchboard successfully pushed for `projectId`, with its latest pushed tip. */
export function listPublishedRefs(db: Database.Database, projectId: string): PublishedRef[] {
  const rows = db
    .prepare(
      `SELECT remote, ref, head_sha FROM git_push
       WHERE project_id = ? AND outcome = 'ACCEPTED' AND ref LIKE 'refs/heads/%'
       ORDER BY created_at DESC, id DESC`,
    )
    .all(projectId) as { remote: string; ref: string; head_sha: string }[];
  const seen = new Set<string>();
  const out: PublishedRef[] = [];
  for (const r of rows) {
    const key = `${r.remote}\0${r.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sha = r.head_sha.toLowerCase();
    if (!isRemoteName(r.remote) || branchOfPublishRef(r.ref) === undefined || !isFullLowerSha(sha)) continue;
    out.push({ remote: r.remote, publishRef: r.ref, headSha: sha });
  }
  return out.sort((a, b) => (a.publishRef < b.publishRef ? -1 : a.publishRef > b.publishRef ? 1 : 0));
}

/**
 * `owner/repo` of a github.com remote URL (`https://github.com/o/r[.git]`, `ssh://git@github.com/o/r[.git]`,
 * `git@github.com:o/r[.git]`), or undefined for any other host or a URL carrying credentials. Never log the input.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | undefined {
  const m =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url) ??
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url);
  if (m === null) return undefined;
  const owner = m[1] as string;
  const repo = m[2] as string;
  return isGhOwner(owner) && isGhRepo(repo) ? { owner, repo } : undefined;
}

/** Read-only `git config --get remote.<name>.url` in the project's repository, parsed as a github.com remote. */
export async function resolveGithubRemote(
  repoPath: string,
  remote: string,
): Promise<{ owner: string; repo: string } | undefined> {
  if (!isRemoteName(remote)) return undefined;
  try {
    return parseGithubRemote(await gitText(["config", "--get", `remote.${remote}.url`], { cwd: repoPath }));
  } catch {
    return undefined;
  }
}
