/**
 * Answers to ACP `session/request_permission` (ADR-0036 item 9; LLD §2 `decidePermission`; FR-POL-02, FR-POL-03;
 * ROADMAP T4.8, R-62). Delegated agent work, not owner-approved, except where owner decision 48 is cited.
 *
 * {@link decidePermission} reads only the frozen policy snapshot, the provider's declarations and the request. Nothing
 * from the orchestrator, the repository, the agent's text or an earlier answer is an input. It never throws: any
 * unexpected shape is a rejection. Deny by default.
 *
 * - Allow selects the first option whose `kind` is `allow_once`, and only when the tool call's kind is one the profile
 *   allows and every reported location lies inside the worktree (or, for `read` and `search`, a read-only context).
 * - Reject selects the first `reject_once` option; with none, the answer is `cancel_turn` (outcome `cancelled`; the
 *   client then sends `session/cancel` and the run ends `PERMISSION_BLOCKED`). `reject_always` is never selected (it may
 *   persist a rule in the provider's own state, FR-POL-08).
 * - `allow_always` is never selected, in any profile, including an approved bypass run (ADR-0036 item 9.3).
 * - Approved bypass run (`privileged`, `bypassApproved`, scope sets `bypass`; ADR-0017): every request is allowed with
 *   `allow_once` (owner decision 48: "bypass runs dont need permissions requests, aka auto approve"). That
 *   allow-everything rule is bypass-class under FR-POL-03 and is reachable only in this case.
 *
 * Location checks read the file system (`realpathSync` of the longest existing prefix), the one input outside the
 * snapshot and request that ADR-0036 item 9.2 itself requires; a failure to read is a rejection.
 *
 * The answers only narrow: the agent reports `kind`, `locations` and `rawInput` itself and the specification calls
 * option kinds "a hint" ([ACP-TC], ADR-0036 item 9.5), so native provider controls stay the primary control.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type { AcpDeclarations, ResolvedProfile } from "../adapters/types.js";

/** What the decision may read about the run (LLD §2 `AcpPermissionSnapshot`; `writable` added by T4.8). */
export interface AcpPermissionSnapshot {
  readonly profile: ResolvedProfile;
  /** Absolute path of the run worktree (the agent's `cwd`). */
  readonly worktree: string;
  /** Whether the workspace is writable (a worktree, not a read-only inspection); edits need it (ADR-0036 item 9.2). */
  readonly writable: boolean;
  /** Absolute paths the profile may read besides the worktree (declared read-only contexts). */
  readonly readOnlyContexts: readonly string[];
}

export type AcpPermissionDecision =
  | { readonly answer: "allow_once"; readonly optionId: string; readonly reason: string }
  | { readonly answer: "reject_once"; readonly optionId: string; readonly reason: string }
  | { readonly answer: "cancel_turn"; readonly reason: "no_reject_option" | "run_cancelling"; readonly denied: string };

/** Tool call kinds named by ACP v1 (`ToolKind`, [ACP-TC]). Anything else is unknown and rejected. */
const FILE_KINDS = new Set(["read", "edit", "delete", "move"]);
const READ_KINDS = new Set(["read", "search"]);
const WRITE_KINDS = new Set(["edit", "delete", "move"]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** True exactly for an approved bypass run (same three conditions as the argv audit's `bypassPermitted`). */
export function approvedBypass(profile: ResolvedProfile): boolean {
  return (
    profile.name === "privileged" && profile.bypassApproved === true && profile.privilegedScope?.scope.bypass === true
  );
}

interface Option {
  readonly optionId: string;
  readonly kind: string;
}

function readOptions(params: Json): Option[] {
  const raw = params.options;
  if (!Array.isArray(raw)) return [];
  const out: Option[] = [];
  for (const o of raw) {
    if (isObj(o) && typeof o.optionId === "string" && typeof o.kind === "string") {
      out.push({ optionId: o.optionId, kind: o.kind });
    }
  }
  return out;
}

/** The rejection for `reason`: the first `reject_once` option, else `cancel_turn` (never `reject_always`). */
function reject(options: readonly Option[], reason: string): AcpPermissionDecision {
  const r = options.find((o) => o.kind === "reject_once");
  if (r) return { answer: "reject_once", optionId: r.optionId, reason };
  return { answer: "cancel_turn", reason: "no_reject_option", denied: reason };
}

/**
 * The rejection the client sends when the decision failed, threw or missed its bound (ADR-0036 item 9.1): the first
 * `reject_once` option of `request`, else `cancel_turn`. Never throws.
 */
export function rejectionFor(request: unknown, reason: string): AcpPermissionDecision {
  try {
    return reject(readOptions(isObj(request) ? request : {}), reason);
  } catch {
    return { answer: "cancel_turn", reason: "no_reject_option", denied: reason };
  }
}

/** Resolves symlinks in the longest existing prefix of an absolute, lexically normalised path. */
function resolveExisting(p: string): string | undefined {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = path.dirname(head);
      if (parent === head) return undefined;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function inside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Every location is absolute and, once resolved, inside one of `roots`. Returns a reason code when not. */
function checkLocations(locations: readonly unknown[], roots: readonly string[]): string | undefined {
  const realRoots = roots.flatMap((r) => {
    const real = path.isAbsolute(r) ? resolveExisting(path.normalize(r)) : undefined;
    return real === undefined ? [] : [real];
  });
  if (realRoots.length === 0) return "no_root";
  for (const loc of locations) {
    if (!isObj(loc) || typeof loc.path !== "string" || loc.path === "" || loc.path.includes("\0")) {
      return "location_malformed";
    }
    if (!path.isAbsolute(loc.path)) return "location_relative";
    const real = resolveExisting(path.normalize(loc.path));
    if (real === undefined) return "location_unresolvable";
    if (!realRoots.some((root) => inside(real, root))) return "location_outside";
  }
  return undefined;
}

/** Shell, network and file access of the profile in one spelling (a privileged scope maps onto it). */
interface Grants {
  readonly writeFiles: boolean;
  readonly shell: { mode: "none" | "broad" } | { mode: "allowlist"; argvs: readonly (readonly string[])[] };
  readonly network: { mode: "off" | "on" } | { mode: "allowlist"; hosts: readonly string[] };
}

function grants(p: ResolvedProfile): Grants {
  const scope = p.privilegedScope?.scope;
  if (p.name === "privileged") {
    // Without a scope nothing beyond reading is granted (fail closed).
    if (scope === undefined) return { writeFiles: false, shell: { mode: "none" }, network: { mode: "off" } };
    return {
      writeFiles: scope.files.access === "worktree",
      shell:
        scope.shell.mode === "allowlist"
          ? { mode: "allowlist", argvs: scope.shell.allowlist }
          : { mode: scope.shell.mode },
      network:
        scope.network.mode === "allowlist"
          ? { mode: "allowlist", hosts: scope.network.hosts }
          : { mode: scope.network.mode },
    };
  }
  return {
    writeFiles: p.fileAccess === "worktree",
    // Profile allowlist entries are plain commands with plain arguments (as the Claude Code adapter reads them).
    shell:
      p.shell === "broad"
        ? { mode: "broad" }
        : p.shell === "allowlist"
          ? { mode: "allowlist", argvs: (p.shellAllowlist ?? []).map((e) => e.trim().split(/\s+/u)) }
          : { mode: "none" },
    network:
      p.network === "allowlist"
        ? { mode: "allowlist", hosts: p.networkAllowlist ?? [] }
        : p.network === "policy"
          ? { mode: "on" }
          : { mode: "off" },
  };
}

const sameArgv = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((w, i) => w === b[i]);

/** Reason code when the profile does not allow tool `kind`, else undefined. */
function kindRefusal(kind: string, toolCall: Json, s: AcpPermissionSnapshot, decl: AcpDeclarations | undefined) {
  const g = grants(s.profile);
  if (READ_KINDS.has(kind)) return undefined;
  if (WRITE_KINDS.has(kind)) return g.writeFiles && s.writable ? undefined : "kind_not_in_profile";
  if (kind === "execute") {
    if (g.shell.mode === "broad") return undefined;
    if (g.shell.mode === "allowlist" && decl?.parseExecute) {
      let argv: string[] | null = null;
      try {
        argv = decl.parseExecute(toolCall);
      } catch {
        argv = null;
      }
      if (argv !== null && g.shell.argvs.some((entry) => sameArgv(entry, argv as string[]))) return undefined;
      return "execute_not_allowlisted";
    }
    return "kind_not_in_profile";
  }
  if (kind === "fetch") {
    if (g.network.mode === "on") return undefined;
    if (g.network.mode === "allowlist" && decl?.parseFetchHost) {
      let host: string | null = null;
      try {
        host = decl.parseFetchHost(toolCall);
      } catch {
        host = null;
      }
      const h = host?.toLowerCase();
      if (h !== undefined && g.network.hosts.some((x) => x.toLowerCase() === h)) return undefined;
      return "host_not_allowlisted";
    }
    return "kind_not_in_profile";
  }
  // `think`, `switch_mode`, `other` and any kind ACP v1 does not name.
  return "kind_refused";
}

/**
 * The answer to one `session/request_permission` request (`request` is its JSON-RPC `params`). Pure apart from the
 * location resolution described in the module comment; never throws.
 */
export function decidePermission(
  request: unknown,
  snapshot: AcpPermissionSnapshot,
  decl?: AcpDeclarations,
): AcpPermissionDecision {
  try {
    const params = isObj(request) ? request : {};
    const options = readOptions(params);
    const toolCall = params.toolCall;
    if (approvedBypass(snapshot.profile)) {
      // Owner decision 48: allow every request, but only ever with `allow_once` (never `allow_always`).
      const allow = options.find((o) => o.kind === "allow_once");
      if (allow) return { answer: "allow_once", optionId: allow.optionId, reason: "approved_bypass" };
      return reject(options, "no_allow_once_option");
    }
    if (!isObj(toolCall)) return reject(options, "no_tool_call");
    const kind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
    if (kind === undefined) return reject(options, "kind_missing");
    const refusal = kindRefusal(kind, toolCall, snapshot, decl);
    if (refusal !== undefined) return reject(options, refusal);
    const locations = toolCall.locations === undefined ? [] : toolCall.locations;
    if (!Array.isArray(locations)) return reject(options, "location_malformed");
    if (FILE_KINDS.has(kind) && locations.length === 0) return reject(options, "location_missing");
    const roots = READ_KINDS.has(kind) ? [snapshot.worktree, ...snapshot.readOnlyContexts] : [snapshot.worktree];
    const where = locations.length === 0 ? undefined : checkLocations(locations, roots);
    if (where !== undefined) return reject(options, where);
    const allow = options.find((o) => o.kind === "allow_once");
    if (!allow) return reject(options, "no_allow_once_option");
    return { answer: "allow_once", optionId: allow.optionId, reason: "in_profile" };
  } catch {
    return { answer: "cancel_turn", reason: "no_reject_option", denied: "decision_error" };
  }
}
