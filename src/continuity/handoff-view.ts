/**
 * The `handoff_view` artifact (T5.4; LLD §15.2 "Storage", §15.3 `handoff_built`, §15.7 steps 5 and 6; ADR-0038 items 2,
 * 3 and 7; FR-SES-05, FR-TEL-03).
 *
 * A thin store step over the pure builder: build the bundle, put its bytes in the artifact store (which redacts them
 * once more, FR-TEL-03, and addresses them by SHA-256), then, in one ledger transaction, insert the `handoff_view`
 * artifact row (`application/json`, `run_id` = the receiving run, `meta_session_id` set) and the `handoff_built`
 * decision through the T5.3 helper. Any failure before that transaction commits throws {@link HandoffBundleError} and
 * leaves no row; an artifact file already stored is an orphan for retention GC (LLD §15.7 step 5).
 *
 * T5.6 owns the caller (`continue_task`): it may call {@link storeHandoffView} before its admission transaction commits
 * the run, or build and put first and call {@link recordHandoffView} inside its own admission transaction.
 */

import { type BuildDeps, type BuiltBundle, buildHandoffBundle } from "./bundle.js";
import { type AsOf, type BundleBounds, HandoffBundleError } from "./bundle-schema.js";
import type { BundleLedger } from "./bundle-sources.js";
import type { DecisionInput } from "./decisions.js";

const fail = (cause: string): never => {
  throw new HandoffBundleError(cause);
};

export const HANDOFF_VIEW_MEDIA_TYPE = "application/json";

/** The writes the store step needs; `createLedger` satisfies it. */
export interface HandoffViewLedger extends BundleLedger {
  immediate<T>(fn: () => T): T;
  insertArtifact(input: {
    /** Pre-allocated id (T5.5: the receiving run's `request_json.handoff` names it in the same transaction). */
    id?: string;
    runId: string | null;
    metaSessionId: string | null;
    kind: "handoff_view";
    sha256: string;
    sizeBytes: number;
    mediaType: string;
  }): string;
  appendDecision(input: DecisionInput): { id: string; created: boolean };
}

/** The artifact store's `put` (it redacts, then addresses by the SHA-256 of the stored bytes). */
export interface HandoffViewStore {
  put(content: Buffer): Promise<{ sha256: string; sizeBytes: number }>;
}

export interface StoredHandoffView {
  readonly artifactId: string;
  readonly decisionId: string;
  readonly sha256: string;
  readonly asOfSha256: string;
  readonly sizeBytes: number;
  readonly built: BuiltBundle;
}

/**
 * Inside the caller's transaction: insert the `handoff_view` row for `receivingRunId` and its `handoff_built` decision
 * (once per cause; the helper refuses a terminal receiving run, which rolls the transaction back). Synchronous.
 */
export function recordHandoffView(
  ledger: HandoffViewLedger,
  input: {
    receivingRunId: string;
    built: BuiltBundle;
    stored: { sha256: string; sizeBytes: number };
    /** T5.5: an id pre-allocated with `Ledger.newArtifactId` so the run's request can name it (LLD §15.2). */
    artifactId?: string;
  },
): { artifactId: string; decisionId: string } {
  const { receivingRunId, built, stored } = input;
  if (stored.sha256 !== built.sha256) throw new HandoffBundleError("the stored view does not match the built bytes");
  return ledger.immediate(() => {
    const receiving = ledger.getRunRecord(receivingRunId) ?? fail("the receiving run is missing");
    if (receiving.meta_session_id !== built.bundle.as_of.meta_session_id)
      fail("the receiving run is in another session");
    if (built.bundle.as_of.runs.some((r) => r.run_id === receivingRunId)) fail("the receiving run is a source run");
    const artifactId = ledger.insertArtifact({
      ...(input.artifactId !== undefined ? { id: input.artifactId } : {}),
      runId: receivingRunId,
      metaSessionId: built.bundle.as_of.meta_session_id,
      kind: "handoff_view",
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mediaType: HANDOFF_VIEW_MEDIA_TYPE,
    });
    let decisionId: string;
    try {
      decisionId = ledger.appendDecision({
        kind: "handoff_built",
        runId: receivingRunId,
        bundleArtifactId: artifactId,
        bundleSha256: built.sha256,
        asOfSha256: built.asOfSha256,
        sourceRuns: built.bundle.as_of.runs.length,
      }).id;
    } catch {
      // Rolls back the artifact row with it (one transaction or savepoint).
      return fail("the handoff_built decision was refused");
    }
    return { artifactId, decisionId };
  });
}

/**
 * T5.5: build the bundle at `asOf` and put its bytes in the artifact store, writing no ledger row. The caller then
 * submits the receiving run with `SubmitRequest.handoff = { built, stored, ... }`, and the lifecycle records the view
 * ({@link recordHandoffView}) in the run's admission transaction. Throws {@link HandoffBundleError}.
 */
export async function buildAndPutHandoffView(
  deps: BuildDeps & { store: HandoffViewStore },
  input: { asOf: AsOf; bounds: BundleBounds },
): Promise<{ built: BuiltBundle; stored: { sha256: string; sizeBytes: number } }> {
  const built = await buildHandoffBundle(deps, input.asOf, input.bounds);
  let stored: { sha256: string; sizeBytes: number };
  try {
    stored = await deps.store.put(built.bytes);
  } catch {
    return fail("the view could not be stored");
  }
  if (stored.sha256 !== built.sha256) fail("the stored view does not match the built bytes");
  return { built, stored: { sha256: stored.sha256, sizeBytes: stored.sizeBytes } };
}

/**
 * Build the bundle at `asOf` with `bounds`, store it and record it for `receivingRunId` (a non-terminal run of the same
 * meta-session that is not one of the source runs). Throws {@link HandoffBundleError}; no row is written then.
 */
export async function storeHandoffView(
  deps: BuildDeps & { ledger: HandoffViewLedger; store: HandoffViewStore },
  input: { receivingRunId: string; asOf: AsOf; bounds: BundleBounds },
): Promise<StoredHandoffView> {
  const built = await buildHandoffBundle(deps, input.asOf, input.bounds);
  let stored: { sha256: string; sizeBytes: number };
  try {
    stored = await deps.store.put(built.bytes);
  } catch {
    return fail("the view could not be stored");
  }
  const { artifactId, decisionId } = recordHandoffView(deps.ledger, {
    receivingRunId: input.receivingRunId,
    built,
    stored,
  });
  return {
    artifactId,
    decisionId,
    sha256: built.sha256,
    asOfSha256: built.asOfSha256,
    sizeBytes: stored.sizeBytes,
    built,
  };
}
