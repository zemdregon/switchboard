/**
 * Rules for dynamic project definitions (T9.9; FR-PRJ-10, FRD BR-32, LLD §3 and §11, ADR-0030). A definition has the
 * shape of a configured project (LLD §11.1, `projectSchema`, already checked by the tool's input schema), passes the
 * same structural rules as configuration (`checkProjects`) and the same filesystem rules as `projects validate`
 * (`checkProject`), and in addition stays inside the creating client's limits. Delegated, Proposed choices (all fail
 * closed) are marked **Delegated** below.
 *
 * Refusal codes: a malformed definition is `INVALID_REQUEST`; a definition outside the client's limits (ceiling,
 * providers, push policy, a repository outside every allowed root or inside the controller's data directory, a quota)
 * is `PERMISSION_BLOCKED` (FRD BR-32 "not allowed").
 */
import { realpath } from "node:fs/promises";
import { checkProject } from "../cli/projects.js";
import {
  checkProjects,
  effectiveMaxProfile,
  isUnderAllowedRoot,
  type ProjectConfig,
  type ResolvedProject,
  resolveProjects,
  type SwitchboardConfig,
  TRUST_PROFILES,
  type TrustProfile,
} from "../config/index.js";

export type RuleCode = "INVALID_REQUEST" | "PERMISSION_BLOCKED";

/** A refused definition: one taxonomy code, a reason code from a fixed vocabulary and the offending field. */
export class ProjectRuleError extends Error {
  override readonly name = "ProjectRuleError";
  constructor(
    readonly code: RuleCode,
    readonly reason: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** The calling client's limits (its `mcp_clients[]` entry). */
export interface ClientLimits {
  readonly maxTrustProfile: TrustProfile;
  readonly maxPushPolicy: "none" | "branch";
}

/**
 * **Delegated** quotas (Assumption: no source gives numbers): live dynamic projects per client and revisions per
 * project, so an orchestrator cannot grow the ledger without bound through these tools.
 */
export const MAX_LIVE_PROJECTS_PER_CLIENT = 32;
export const MAX_REVISIONS_PER_PROJECT = 100;

/** Reasons a revision waits for the operator (`approval_needed` in the tool result; stored with the revision). */
export const APPROVAL_REASONS = [
  "container_environment",
  "push_policy",
  "commit_identity",
  "commit_signing",
  "widened_trust_ceiling",
  "widened_providers",
] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

const PUSH_RANK = { none: 0, branch: 1 } as const;
const rank = (p: TrustProfile) => TRUST_PROFILES.indexOf(p);

/**
 * **Delegated**: every string in a definition must be free of C0/C1 control characters (NUL included), DEL, Unicode
 * line/paragraph separators, bidirectional overrides and isolates, and unpaired surrogates. Such characters have no
 * place in a project name, path, ref or identity, and the operator reads these values on the CLI.
 */
export function checkStrings(value: unknown, at = "$.project"): void {
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      const bad =
        c < 0x20 ||
        (c >= 0x7f && c <= 0x9f) ||
        c === 0x2028 ||
        c === 0x2029 ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069) ||
        c === 0x200e ||
        c === 0x200f ||
        c === 0xfeff ||
        (c >= 0xd800 && c <= 0xdbff && !(i + 1 < value.length && isLow(value.charCodeAt(i + 1)))) ||
        (isLow(c) && !(i > 0 && isHigh(value.charCodeAt(i - 1))));
      if (bad) {
        throw new ProjectRuleError(
          "INVALID_REQUEST",
          "CONTROL_CHARACTER",
          `${at}: control, separator or bidirectional characters are not allowed`,
          at,
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      checkStrings(v, `${at}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) checkStrings(v, `${at}.${k}`);
  }
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The configuration loader's structural rules (unique context ids, one primary, push needs identity, ...). */
export function checkStructure(def: ProjectConfig): void {
  const errs = checkProjects({ projects: [def] } as SwitchboardConfig);
  const first = errs[0];
  if (first !== undefined) {
    const rewritten = first.replace("$.projects[0]", "$.project");
    const colon = rewritten.indexOf(": ");
    throw new ProjectRuleError(
      "INVALID_REQUEST",
      "INVALID_DEFINITION",
      `invalid project: ${rewritten}`,
      colon > 0 ? rewritten.slice(0, colon) : "$.project",
    );
  }
}

/** The definition as COMP-PRJ resolves configured projects. */
export function toResolved(def: ProjectConfig): ResolvedProject {
  return resolveProjects({ projects: [def] } as SwitchboardConfig)[0] as ResolvedProject;
}

/**
 * FR-PRJ-10 limits: the trust ceiling no wider than the client's; providers within the client's set; every context's
 * push policy no wider than `max_push_policy`. **Delegated**: SRS and LLD give a client no provider list of its own
 * (`mcp_clients[]` has none), so the client's provider set is every provider the operator has not disabled in
 * `providers`; naming a disabled provider is refused.
 */
export function checkClientLimits(
  def: ProjectConfig,
  client: ClientLimits,
  disabledProviders: ReadonlySet<string>,
): void {
  if (def.max_trust_profile !== undefined && rank(def.max_trust_profile) > rank(client.maxTrustProfile)) {
    throw new ProjectRuleError(
      "PERMISSION_BLOCKED",
      "CEILING_ABOVE_CLIENT",
      `max_trust_profile ${def.max_trust_profile} exceeds this client's maximum ${client.maxTrustProfile}`,
      "$.project.max_trust_profile",
    );
  }
  for (const [i, p] of (def.allowed_providers ?? []).entries()) {
    if (disabledProviders.has(p)) {
      throw new ProjectRuleError(
        "PERMISSION_BLOCKED",
        "PROVIDER_OUTSIDE_CLIENT",
        `provider ${p} is not available to this client`,
        `$.project.allowed_providers[${i}]`,
      );
    }
  }
  for (const [i, c] of def.contexts.entries()) {
    const policy = c.push?.policy ?? "none";
    if (PUSH_RANK[policy] > PUSH_RANK[client.maxPushPolicy]) {
      throw new ProjectRuleError(
        "PERMISSION_BLOCKED",
        "PUSH_ABOVE_CLIENT",
        `push policy ${policy} exceeds this client's maximum ${client.maxPushPolicy}`,
        `$.project.contexts[${i}].push.policy`,
      );
    }
  }
}

/**
 * T12.1 (FR-RAG-09, FR-RAG-10, LLD §14.1; **Delegated**, fail closed): a dynamic definition may narrow retrieval
 * (`mode: "off"`, lower caps, more exclusions) but may not set `use_global` or `contribute_to_global`. Both move content
 * across projects, so only the operator turns them on, in the configuration file.
 */
export function checkRagSharing(def: ProjectConfig): void {
  for (const flag of ["use_global", "contribute_to_global"] as const) {
    if (def.rag?.[flag] === true) {
      throw new ProjectRuleError(
        "PERMISSION_BLOCKED",
        "RAG_SHARING_OPERATOR_ONLY",
        `rag.${flag} can only be set by the operator in the configuration file`,
        `$.project.rag.${flag}`,
      );
    }
  }
  for (const [i, c] of def.contexts.entries()) {
    if (c.rag?.contribute_to_global === true) {
      throw new ProjectRuleError(
        "PERMISSION_BLOCKED",
        "RAG_SHARING_OPERATOR_ONLY",
        "rag.contribute_to_global can only be set by the operator in the configuration file",
        `$.project.contexts[${i}].rag.contribute_to_global`,
      );
    }
  }
}

/**
 * Why a revision must wait for the operator (FR-PRJ-10, BR-32): a `container` environment, any push policy other than
 * `none`, and any widening of the revision in force. **Delegated** additions: a commit identity (it names the author
 * of published commits, LLD §11.2 says an orchestrator must not invent one; the `identities` list proposed there is not
 * built) and `sign: true` (it would make the controller sign with the operator's key, FR-GIT-10). Widening is measured
 * against the revision in force: a higher effective ceiling, or a provider set that is no longer a subset (absent means
 * every provider).
 */
export function approvalReasons(
  def: ProjectConfig,
  inForce: ProjectConfig | undefined,
  clientMax: TrustProfile,
): ApprovalReason[] {
  const out = new Set<ApprovalReason>();
  if ((def.environment?.kind ?? "host") === "container") out.add("container_environment");
  for (const c of def.contexts) {
    if ((c.push?.policy ?? "none") !== "none") out.add("push_policy");
    if (c.identity !== undefined) out.add("commit_identity");
    if (c.sign === true) out.add("commit_signing");
  }
  if (inForce !== undefined) {
    const now = effectiveMaxProfile(clientMax, toResolved(def));
    const before = effectiveMaxProfile(clientMax, toResolved(inForce));
    if (rank(now) > rank(before)) out.add("widened_trust_ceiling");
    if (inForce.allowed_providers !== undefined) {
      const was = new Set(inForce.allowed_providers);
      if (def.allowed_providers === undefined || def.allowed_providers.some((p) => !was.has(p))) {
        out.add("widened_providers");
      }
    }
  }
  return APPROVAL_REASONS.filter((r) => out.has(r));
}

/**
 * The T9.1 filesystem rules for every context (absolute path; `realpath` under an allowed root, so `..` and symlink
 * escapes are refused; a Git repository whose top level is under an allowed root; `base_ref` resolves to a commit), plus
 * **Delegated**: no context inside the controller's data directory (worktrees, ledger). Only the reason code and the
 * field are reported, never a resolved path. A `container` revision waits for approval; once in force it is admitted
 * only where `serve` wired a container environment (T10.1), and refused at admission otherwise.
 */
export async function checkFilesystem(
  def: ProjectConfig,
  allowedRoots: readonly string[],
  dataDir: string | undefined,
): Promise<void> {
  const failures = await checkProject({ allowedRoots: [...allowedRoots] }, toResolved(def), "$.project");
  const first = failures[0];
  if (first !== undefined) {
    throw new ProjectRuleError(
      first.code === "OUTSIDE_ALLOWED_ROOT" ? "PERMISSION_BLOCKED" : "INVALID_REQUEST",
      first.code,
      `${first.path}: ${FS_TEXT[first.code] ?? "repository check failed"}`,
      first.path,
    );
  }
  if (dataDir === undefined) return;
  let data: string;
  try {
    data = await realpath(dataDir);
  } catch {
    data = dataDir;
  }
  for (const [i, c] of def.contexts.entries()) {
    const canonical = await realpath(c.path);
    if (isUnderAllowedRoot(canonical, [data])) {
      throw new ProjectRuleError(
        "PERMISSION_BLOCKED",
        "INSIDE_DATA_DIR",
        `$.project.contexts[${i}].path: the repository may not be inside the controller's data directory`,
        `$.project.contexts[${i}].path`,
      );
    }
  }
}

/** Fixed texts for the filesystem codes: they never echo a path back (a resolved symlink target could be elsewhere). */
const FS_TEXT: Readonly<Record<string, string>> = {
  PATH_NOT_ABSOLUTE: "the repository path must be absolute",
  PATH_NOT_FOUND: "the repository path does not exist",
  OUTSIDE_ALLOWED_ROOT: "the repository path is not under an allowed root (FR-POL-10)",
  NOT_A_GIT_REPO: "the path is not a Git repository",
  BASE_REF_NOT_FOUND: "base_ref does not resolve to a commit",
};
