/**
 * The context-pack port `serve` wires (T12.5, T5.14; FR-RAG-05, FR-SES-07, LLD §14.6, §20.13). For a run whose frozen
 * project snapshot has no `brief_sha256` it is exactly the retrieval port: same request, same answer, so the prompt is
 * byte-identical to the one before T5.14. For a run with one, the brief frozen at admission is rendered as a labelled
 * block placed before the retrieved context and counted in the same `rag.retrieval.max_context_tokens` budget: its
 * tokens are reserved first, so retrieval is what gets trimmed. The `rag_retrieval` event gains `brief_sha256` and
 * `brief_tokens_est`, never the text.
 *
 * Fail closed (Linus decision (b), WORK QUEUE v10): a brief that can no longer be found by its frozen hash, or whose block
 * alone exceeds the budget, makes the port answer `refuse`, and the lifecycle fails the run instead of dispatching
 * without it. Retrieval is raced against the port's own timeout, so a slow index can only drop the snippets, never the
 * brief (the lifecycle waits `CONTEXT_PACK_GRACE_MS` longer).
 */
import { randomBytes } from "node:crypto";
import type { ResolvedProject } from "../config/index.js";
import type { ContextPackOutcome, ContextPackPort, ContextPackRequest } from "../lifecycle/index.js";
import { BRIEF_NONCE_HEX, briefTokens, frozenBrief, renderBriefBlock } from "../projects/brief.js";

export interface BriefContextPackDeps {
  /** `rag.retrieval.admission_timeout_ms`. */
  readonly timeoutMs: number;
  /** `rag.retrieval.max_context_tokens`: the budget shared by the brief and the retrieved snippets. */
  readonly maxContextTokens: number;
  readonly allowedRoots: readonly string[];
  /** The run's `policy_snapshot_json`, where admission froze `project.brief_sha256`. */
  readonly policySnapshot: (runId: string) => string | undefined;
  /** The configured project, for its `brief_file` when the text is no longer in memory (after a restart). */
  readonly project: (projectId: string) => Pick<ResolvedProject, "briefFile" | "contexts"> | undefined;
  /** The retrieval port; `reservedTokens` come off its budget first. Undefined when retrieval is inert. */
  readonly retrieve: (request: ContextPackRequest, reservedTokens: number) => Promise<ContextPackOutcome | undefined>;
  /** Block delimiter nonce; tests pin it. */
  readonly nonce?: () => string;
}

/** The run's frozen brief hash, or undefined (no brief, no snapshot, or a snapshot written before T5.14). */
function frozenHash(json: string | undefined): string | undefined {
  if (json === undefined) return undefined;
  try {
    const sha = (JSON.parse(json) as { project?: { brief_sha256?: unknown } }).project?.brief_sha256;
    return typeof sha === "string" ? sha : undefined;
  } catch {
    return undefined;
  }
}

export function briefContextPack(deps: BriefContextPackDeps): ContextPackPort {
  const nonce = deps.nonce ?? (() => randomBytes(BRIEF_NONCE_HEX / 2).toString("hex"));
  return {
    timeoutMs: deps.timeoutMs,
    prepare: async (request) => {
      const sha = frozenHash(deps.policySnapshot(request.runId));
      if (sha === undefined) return deps.retrieve(request, 0);
      const project = deps.project(request.projectId);
      const forbidden = [...deps.allowedRoots, ...(project?.contexts ?? []).map((c) => c.path)];
      const brief = frozenBrief(sha, project?.briefFile, forbidden);
      if (brief === undefined) {
        return {
          text: null,
          event: { outcome: "unavailable", reason: "PROJECT_BRIEF_UNAVAILABLE", brief_sha256: sha },
          refuse: `project ${request.projectId}: the brief frozen at admission (sha256 ${sha}) is no longer available`,
        };
      }
      const block = renderBriefBlock(request.projectId, brief, nonce());
      const reserved = briefTokens(`${block}\n\n`);
      if (reserved > deps.maxContextTokens) {
        return {
          text: null,
          event: { outcome: "unavailable", reason: "PROJECT_BRIEF_OVER_BUDGET", brief_sha256: sha },
          refuse: `project ${request.projectId}: the brief needs about ${reserved} tokens; the context budget is ${deps.maxContextTokens}`,
        };
      }
      // Retrieval gets its own abort, so the brief is answered within the port's timeout whatever the index does.
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), Math.max(0, deps.timeoutMs));
      });
      const asked = Promise.resolve().then(() => deps.retrieve({ ...request, signal: ctrl.signal }, reserved));
      asked.catch(() => {}); // a late rejection must not become an unhandled one
      let retrieved: ContextPackOutcome | undefined | "late" | "error";
      try {
        retrieved = await Promise.race([asked, late]);
      } catch {
        retrieved = "error";
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      }
      if (retrieved === "late") ctrl.abort();
      const pack = typeof retrieved === "object" && typeof retrieved.text === "string" ? retrieved.text : "";
      const event =
        retrieved === "late"
          ? { outcome: "unavailable", reason: "TIMEOUT" }
          : retrieved === "error"
            ? { outcome: "unavailable", reason: "RETRIEVAL_ERROR" }
            : (retrieved?.event ?? { outcome: "skipped", reason: "INERT" });
      return {
        text: pack.length > 0 ? `${block}\n\n${pack}` : block,
        event: { ...event, brief_sha256: sha, brief_tokens_est: reserved },
      };
    },
  };
}
