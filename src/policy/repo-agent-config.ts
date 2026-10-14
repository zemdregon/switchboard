/**
 * Repository-local agent configuration (Q-63; FR-POL-04 repository config, FR-POL-08, ADR-0039). A repository can ship
 * files that a provider CLI loads from the working directory: MCP server definitions (a stdio server is a command the
 * CLI starts) and hooks (a command the CLI runs on an event). On Ampere 2026-10-14 `agy` 1.3.4 started a repository's
 * `.agents/mcp_config.json` stdio server and ran its `.agents/hooks.json` hooks under `agy -p` at default settings,
 * with no approval ([live-checks-2026-10-14-antigravity.md](../../docs/research/live-checks-2026-10-14-antigravity.md)
 * C11). A worktree is attacker-influenced content for an untrusted profile, so Switchboard refuses the run itself
 * instead of relying on the provider's trust or approval prompt: with `repoConfig: "disabled"` (every non-privileged
 * profile, and a privileged scope with `repository_config.mode` `disabled`) a worktree that contains one of a
 * provider's repo-local config paths does not start.
 *
 * The path lists are the ones a live check observed the CLI read or name, per provider (Assumption: not exhaustive;
 * an entry is added when a check shows the CLI loads another path). Providers whose adapter already isolates repo
 * config with flags (Claude Code, Codex) are not listed. The check is `lstat` only: no file is read or opened.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedProfile } from "../adapters/types.js";
import { SCOPE_REPO_CONFIG_TO_PROFILE } from "./scope.js";

export const REPO_AGENT_CONFIG_PATHS: Readonly<Record<string, readonly string[]>> = {
  // C11: both executed at default settings.
  antigravity: [".agents/mcp_config.json", ".agents/hooks.json", ".agents"],
  // Grok live check step 10a/5f: `.mcp.json` and `.grok/config.toml` servers listed, project hooks, custom sandbox profiles.
  grok: [".mcp.json", ".grok/config.toml", ".grok/hooks", ".grok/sandbox.toml"],
  // Cursor live check 12a/10c: `.cursor/mcp.json` (needs approval); `.cursor/sandbox.json` and `cli.json` named, not run.
  cursor: [".cursor/mcp.json", ".cursor/sandbox.json", ".cursor/cli.json"],
  // OpenCode live check 10c: a repo `opencode.json` `mcp` entry was attempted.
  opencode: ["opencode.json", ".opencode"],
};

/** The repo-local config paths of `provider` present under `cwd` (relative names, in table order). */
export function repoAgentConfigPresent(provider: string, cwd: string): string[] {
  const out: string[] = [];
  for (const rel of REPO_AGENT_CONFIG_PATHS[provider] ?? []) {
    try {
      lstatSync(join(cwd, rel));
      out.push(rel);
    } catch {
      // absent (or unreadable): not present
    }
  }
  return out;
}

/**
 * Why a run must not start, or `undefined`. Only `repoConfig: "disabled"` refuses; any other value means an approved
 * scope or profile allows repository config for this run (the operator approved it, FR-POL-09).
 */
export function repoAgentConfigRefusal(
  provider: string,
  repoConfig: "disabled" | "approved-only" | "allowlisted" | "scoped",
  cwd: string,
): string | undefined {
  if (repoConfig !== "disabled") return undefined;
  const present = repoAgentConfigPresent(provider, cwd);
  if (present.length === 0) return undefined;
  return `repository config ${present.join(", ")} would be loaded by ${provider}; repoConfig is disabled`;
}

/**
 * The `repoConfig` this run is held to. A privileged snapshot always records `repoConfig: "scoped"` (the scope owns the
 * decision), so the approved scope's `repository_config.mode` decides: `disabled` stays disabled (the refusal applies),
 * `approved` and `enabled` lift it. A mode with no mapping fails closed to `disabled`.
 */
export function effectiveRepoConfig(
  profile: Pick<ResolvedProfile, "repoConfig" | "privilegedScope">,
): ResolvedProfile["repoConfig"] {
  const scope = profile.privilegedScope?.scope;
  if (scope === undefined) return profile.repoConfig;
  const mapped = SCOPE_REPO_CONFIG_TO_PROFILE[scope.repository_config.mode];
  if (mapped === undefined) return "disabled";
  return mapped ?? "scoped";
}
