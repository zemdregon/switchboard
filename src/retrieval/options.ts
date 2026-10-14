/**
 * Scanner options for one context (T12.2; FR-RAG-02, FR-RAG-11, LLD §14.1, §14.3). Applies the context's narrowing-only
 * `rag` block on top of the project's effective setting (`effectiveProjectRag`, T12.1): a context `mode: "off"` skips the
 * context, caps are the lower of the two, and exclusions are the union.
 */
import type { ContextRagConfig, EffectiveProjectRag } from "../config/index.js";
import type { ScanOptions } from "./scan.js";

/** `undefined` when the project or this context has retrieval off: the context is not scanned at all. */
export function scanOptionsForContext(
  project: EffectiveProjectRag,
  context: ContextRagConfig | undefined,
): ScanOptions | undefined {
  if (!project.enabled || context?.mode === "off") return undefined;
  const c = context?.caps;
  const min = (v: number | undefined, base: number) => Math.min(v ?? base, base);
  return {
    maxFileBytes: min(c?.max_file_bytes, project.caps.maxFileBytes),
    maxFiles: min(c?.max_files, project.caps.maxFiles),
    maxChunks: min(c?.max_chunks, project.caps.maxChunks),
    maxTotalBytes: min(c?.max_total_bytes, project.caps.maxTotalBytes),
    exclude: [...project.exclude, ...(context?.exclude ?? [])],
  };
}
