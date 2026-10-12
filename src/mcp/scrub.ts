/**
 * Outbound text scrubbing for MCP results (FR-MCP-04, BR-21, NFR-SEC-01). Two layers, both Proposed safety nets on top
 * of the primary control (envelopes are built from controller-owned fields, never raw provider output):
 *   1. the artifact secret redactor (credential-shaped tokens become `[REDACTED]`);
 *   2. absolute paths outside the operator's allowed roots become `<path>`, so worktree, data-dir, home-directory and
 *      binary locations never reach the orchestrator. Paths under an allowed root (the caller's own workspace) stay.
 * Artifact `inline_text` (a diff of the caller's repository) is not path-scrubbed; it is redacted at storage time.
 */
import path from "node:path";
import { defaultRedactor } from "../artifacts/index.js";
import { isUnderAllowedRoot } from "../config/index.js";

const ABS_PATH = /(?<![\w.~/-])\/[^\s"'`,;()<>[\]{}|]+/g;

export function createScrubber(allowedRoots: readonly string[]): (s: string) => string {
  const roots = allowedRoots.map((r) => path.resolve(r));
  return (text) => {
    const redacted = defaultRedactor(Buffer.from(text, "utf8")).toString("utf8");
    return redacted.replace(ABS_PATH, (p) => {
      const clean = p.replace(/[.:]+$/, "");
      return isUnderAllowedRoot(path.resolve(clean), roots) ? p : `<path>${p.slice(clean.length)}`;
    });
  };
}
