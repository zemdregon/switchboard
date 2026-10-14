/**
 * Working directory of a native resume (T5.7; ADR-0038 item 6, LLD §15.6, FR-SES-03, FR-WS-01, 02, 08, NFR-SEC-06).
 *
 * A resume whose adapter does not declare `resumeCwd: 'independent'` runs in the worktree path of the run that created
 * the native session (its origin), with its own new branch at the head checkpoint; `unverified` is handled as `bound`.
 * When that path cannot be used, no resume is attempted anywhere else: the plan says `unavailable`, which the caller
 * turns into a refusal before admission (and, from T5.6, into a handoff with reason
 * {@link RESUME_DIRECTORY_UNAVAILABLE}), or the LEASED re-check fails the run before spawn.
 *
 * The origin is derived from records only (LLD §15.6 step 1): the earliest run of the meta-session on the bound provider
 * whose terminal `state_transition` payload carries the binding's native session id.
 */
import { resumeMayChangeDirectory } from "../adapters/types.js";
import type { Ledger, RunRecord, TrustProfile } from "../ledger/index.js";
import type { ResumeDirectoryProblem, WorkspaceManager } from "../workspace/index.js";
import { isTerminal } from "./states.js";

/** The route reason code of LLD §15.6 step 3 and §15.7; also `details.reason` of today's refusal. */
export const RESUME_DIRECTORY_UNAVAILABLE = "resume_directory_unavailable";

/**
 * Why a resume cannot use its origin directory: a workspace check (`ResumeDirectoryProblem`), or
 * - `no_origin_run`: no terminal run of this meta-session on the bound provider reported the native session id;
 * - `directory_mismatch` (Delegated, LLD §15.6 is silent on read-only runs): the resume would run in a different kind of
 *   directory than its origin (a write profile resuming a session created under `inspect-untrusted`, which has no
 *   worktree, or the reverse, or a different workspace path).
 */
export type ResumeUnavailableProblem = ResumeDirectoryProblem | "no_origin_run" | "directory_mismatch";

export type ResumeDirectoryPlan =
  /** The adapter declares `independent`: a fresh path `<data>/worktrees/<sess>/<run>` as for any run. */
  | { readonly kind: "fresh" }
  /**
   * Resume in the origin's directory. `originPath` is the origin worktree; `null` means the origin ran read-only
   * (`inspect-untrusted`) in the canonical workspace, where a read-only resume also runs (no worktree either way).
   */
  | { readonly kind: "origin"; readonly originRunId: string; readonly originPath: string | null }
  | { readonly kind: "unavailable"; readonly problem: ResumeUnavailableProblem; readonly detail: string };

export interface ResumeDirectoryQuestion {
  readonly metaSessionId: string;
  readonly provider: string;
  readonly nativeSessionId: string;
  /** Profile of the resume run (FRD C4 may change it from the origin's). */
  readonly trustProfile: TrustProfile;
  /** Canonical workspace of the resume run (FRD C3). */
  readonly workspace: string;
  /** The adapter's static declaration; anything but `independent` is handled as `bound`. */
  readonly resumeCwd: unknown;
}

/** LLD §15.6 step 1: the run that created the native session, or undefined. */
export function findResumeOrigin(
  ledger: Ledger,
  metaSessionId: string,
  provider: string,
  nativeSessionId: string,
): RunRecord | undefined {
  // `listRunsForMetaSession` is ordered by (created_at, id): the first match is the earliest.
  for (const run of ledger.listRunsForMetaSession(metaSessionId)) {
    if (run.provider !== provider || !isTerminal(run.state)) continue;
    for (const ev of ledger.listRunEvents(run.id)) {
      if (ev.type !== "state_transition") continue;
      let payload: { to?: unknown; native_session_id?: unknown };
      try {
        payload = JSON.parse(ev.payload_json) as typeof payload;
      } catch {
        continue;
      }
      if (typeof payload.to === "string" && isTerminal(payload.to as RunRecord["state"])) {
        if (payload.native_session_id === nativeSessionId) return run;
      }
    }
  }
  return undefined;
}

/**
 * The directory plan for a resume. With `inspect` (before admission), an origin worktree is also checked by the
 * workspace manager (read-only); without it (at LEASED), `prepare` runs the same check under the worktree
 * serialisation.
 */
export async function planResumeDirectory(
  deps: { readonly ledger: Ledger; readonly workspace: WorkspaceManager },
  q: ResumeDirectoryQuestion,
  options: { readonly inspect: boolean },
): Promise<ResumeDirectoryPlan> {
  if (resumeMayChangeDirectory({ resumeCwd: q.resumeCwd })) return { kind: "fresh" };
  const origin = findResumeOrigin(deps.ledger, q.metaSessionId, q.provider, q.nativeSessionId);
  if (!origin) {
    return {
      kind: "unavailable",
      problem: "no_origin_run",
      detail: "no terminal run of this meta-session on the bound provider reported the native session",
    };
  }
  const readOnly = q.trustProfile === "inspect-untrusted";
  if (origin.worktree_path === null) {
    let originWorkspace: unknown;
    try {
      originWorkspace = (JSON.parse(origin.request_json) as { workspace?: unknown }).workspace;
    } catch {
      originWorkspace = undefined;
    }
    if (!readOnly || originWorkspace !== q.workspace) {
      return {
        kind: "unavailable",
        problem: "directory_mismatch",
        detail: "the native session was created without a worktree; this resume would run in another directory",
      };
    }
    return { kind: "origin", originRunId: origin.id, originPath: null };
  }
  if (readOnly) {
    return {
      kind: "unavailable",
      problem: "directory_mismatch",
      detail: "an inspect-untrusted resume has no worktree; the native session was created in one",
    };
  }
  if (options.inspect) {
    const verdict = await deps.workspace.inspectResumeDirectory(q.metaSessionId, origin.worktree_path);
    if (!verdict.usable) return { kind: "unavailable", problem: verdict.problem, detail: verdict.detail };
  }
  return { kind: "origin", originRunId: origin.id, originPath: origin.worktree_path };
}
