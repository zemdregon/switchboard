/**
 * Claude Code adapter (T2.2; LLD §2 contract; TDD §4.1). Every flag below is cited to its source:
 *   [R2]   docs/research/headless-ai-coding-controller-verified-2026-10-12.md (adapter matrix, "Claude Code" notes,
 *          compliance/authentication boundary, trust-profile section)
 *   [TDD]  docs/design/TDD.md §4.1
 *   [HELP] `claude --help` / `claude auth status --help` of the installed binary, version 2.1.296 (the manifest's
 *          validated_cli_version), read on 2026-10-12 without running a prompt.
 *
 * Flags used (all from [HELP]; the ones also named in [R2]/[TDD] say so):
 *   -p                              non-interactive print mode ([R2], [TDD], [HELP])
 *   --output-format stream-json     structured realtime stream ([R2], [TDD], [HELP])
 *   --verbose                       [R2]/[TDD] pair it with stream-json; Assumption that stream-json under -p needs it
 *   --permission-mode dontAsk       fail-closed: would-prompt operations are denied ([R2], [TDD], [HELP] choices)
 *   --permission-prompts none       nobody answers prompts; would-prompt is denied ([R2], [TDD], [HELP])
 *   --tools <list>                  explicit built-in tool set ([R2] "explicit --tools", [TDD], [HELP])
 *   --allowedTools <rules...>       explicit allow rules, never a wildcard ([R2], [TDD], [HELP])
 *   --disallowedTools <rules...>    deny rules; [HELP]: "Comma or space-separated list of tool names to deny (e.g.
 *                                   "Bash(git *) Edit")". Carries the Git write deny rules (FR-GIT-01); [R2] names
 *                                   only "explicit --tools/allow-deny policy", not this spelling
 *   --safe-mode                     disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands/agents;
 *                                   auth works normally ([HELP] only; see the --bare note below)
 *   --restricted                    removes code-running tools unless --tools names them, ignores user/project/local
 *                                   settings files, confines file tools to the working directory, refuses
 *                                   bypassPermissions, and "lets only a person or the configured permission handler
 *                                   approve writes to settings, git and tool-configuration files" ([HELP] only); with
 *                                   `--permission-prompts none` nobody approves, so file-tool writes to Git files are
 *                                   denied (FR-GIT-01; which files count as "git files" is an Assumption)
 *   --strict-mcp-config             only MCP servers from --mcp-config ([HELP] only); without the operator opt-in
 *                                   below none are passed
 *   --mcp-config <file>             T9.4b, ADR-0029, ADR-0033, ONLY with the operator opt-in
 *                                   `providers.claude-code.git_channel`, only in an approved privileged bypass run
 *                                   (owner decision 41) and only for a run the lifecycle offers the tool channel: the
 *                                   controller-written `0600` definition of the shim (one server, see
 *                                   CLAUDE_GIT_CHANNEL_CAPABILITIES); `--safe-mode` is then removed (it stops the
 *                                   server from starting, live check in PR #41)
 *   --model <model>                 when the request names one ([HELP]; [R2] says the CLI accepts aliases and IDs)
 *   --resume <session-id>           native resume (FR-SES-03; [R2], [TDD], [HELP])
 *   auth status --json              auth preflight (FR-AUTH-02; `claude auth status` per [R2]/[TDD]; --json per [HELP])
 *   --version / --help              probe only ([HELP])
 *
 * Deviation from [TDD] §4.1 (Proposed `--bare` for untrusted profiles): the installed [HELP] says `--bare` makes
 * Anthropic auth "strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)". The
 * Claude manifest allows only `native_cached_subscription`, and Switchboard never handles API keys (ADR-0003), so
 * `--bare` would make every run fail auth. FR-POL-04 is met instead with `--safe-mode --restricted
 * --strict-mcp-config`, all documented in [HELP]. TDD §4.1 needs updating to match (reported, not edited here).
 *
 * Profiles (T3.5, TDD §4.1.1 matrix): `inspect-untrusted` and `edit-untrusted` (T2.2), and `trusted-development` with the
 * same flags as `edit-untrusted`, no new flag, but command-prefix shell allow rules (ADR-0066, see shellRules);
 * `test-sandboxed` and the trusted-development cells with no documented control are `Ineligible` (see
 * matrixIneligible). `privileged` (T3.5, T3.17) compiles from the approved scope (see privilegedPlan), and only there
 * may the one bypass flag below appear:
 *   --dangerously-skip-permissions  [HELP]: "Bypass all permission checks. Recommended only for sandboxes with no
 *                                   internet access." Emitted only when the profile is `privileged`, the scope sets
 *                                   `bypass` and the run's bypassApproved is true (owner decision 13, ADR-0017,
 *                                   LLD §3.1 "Bypass"); the argv audit (../audit.ts) checks the same three again.
 *   In that bypass invocation `--restricted` is omitted ([HELP]: it "refuses bypassPermissions"; owner decision 19) and
 *   so is `--permission-mode dontAsk` (Assumption: [HELP] does not say how an explicit mode combines with
 *   --dangerously-skip-permissions, so the bypass flag is left as the only mode-setting input); `--safe-mode`,
 *   `--strict-mcp-config` (both omitted in a bypass run whose repository_config is `approved`/`enabled`, owner decision
 *   26, Q-37: see CLAUDE_BYPASS_REPO_CONFIG_ISOLATION_FLAGS), `--permission-prompts none`, `--tools` and the FR-GIT-01 `--disallowedTools` Git deny rules
 *   are kept, and `--add-dir`/`--worktree` are still never emitted. **Assumption (unverified, R-26, live check T3.9 and
 *   live-smoke C-G2):** that `--disallowedTools` deny rules still deny under --dangerously-skip-permissions, and that
 *   `--tools` still limits the available tools under it; [HELP] says neither.
 *
 * Git writes (FR-GIT-01, ADR-0014): see CLAUDE_GIT_WRITE_CONTROL below. No flag documented in [HELP] turns off Claude
 * Code's own commit or attribution behaviour except `--bare` ("skip ... attribution"), which cannot be used (above);
 * settings files are never written (FR-POL-08). Those features are kept unused by denying every way to run Git writes.
 *
 * Never emitted: any BYPASS_FLAGS entry other than the approved privileged bypass above,
 * `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions|acceptEdits|auto`, `--settings`,
 * `--setting-sources`, `--mcp-config` (except the opt-in channel definition above, ADR-0029, ADR-0033), `--plugin-dir`,
 * `--add-dir`, `--worktree`/`-w` (creates a Git worktree and branch, [HELP]), `--from-pr`, `--debug-file`, or any
 * config-writing subcommand (FR-POL-03, FR-POL-08, FR-GIT-01).
 */
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { CHANNEL_MCP_CONFIG_FILE, TOOL_NAMES, TOOL_SHIM_MCP_SERVER, TOOL_TOKEN_ENV } from "../../git/tool-protocol.js";
import type { PrivilegedScope } from "../../policy/types.js";
import { channelToolRule, SAFE_MODE_FLAG } from "../audit.js";
import { classifyCommon } from "../failure.js";
import {
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_OPTIONS_WITH_VALUE,
  GIT_PUBLISHING_PROGRAMS,
  GIT_WRITE_SUBCOMMANDS,
  gitWriteRisks,
} from "../git-write.js";
import { renderPrompt } from "../prompt.js";
import type {
  AcpMessage,
  AuthResult,
  ChannelArgs,
  CompileRequest,
  ExitInfo,
  FailureClassification,
  FailureEvidence,
  GitCapabilities,
  GitWriteControl,
  Ineligible,
  Invocation,
  NativeBinding,
  NormalizedEvent,
  ParseState,
  ProbeResult,
  ProbeRunner,
  ProviderAdapter,
  ResolvedProfile,
  RunResult,
  ShimSpec,
  SkillDelivery,
} from "../types.js";
import { parseClaudeLine } from "./parse.js";

/** Native login the operator runs themselves (FR-AUTH-02). Switchboard never runs it. [HELP]: `claude auth login`. */
export const CLAUDE_LOGIN_COMMAND = "claude auth login";

/** Read-only tools for both untrusted profiles. `Read` is in [HELP]; `Grep` and `Glob` are an Assumption. */
export const CLAUDE_READ_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
/** File-editing tools for edit-untrusted. `Edit` is in [HELP]; `Write` (needed to create files) is an Assumption. */
export const CLAUDE_EDIT_TOOLS: readonly string[] = ["Edit", "Write"];

/** Every flag that is security-relevant, for policyFlags and the argv tests. */
export const CLAUDE_ISOLATION_FLAGS: readonly string[] = ["--safe-mode", "--restricted", "--strict-mcp-config"];
export const CLAUDE_PERMISSION_FLAGS: readonly string[] = [
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
];
/** [HELP] bypass flag, compiled only for an approved privileged scope with `bypass: true` (T3.17). */
export const CLAUDE_BYPASS_FLAG = "--dangerously-skip-permissions";
/** Isolation flags of an approved bypass run: `--restricted` "refuses bypassPermissions" ([HELP]; decision 19). */
export const CLAUDE_BYPASS_ISOLATION_FLAGS: readonly string[] = ["--safe-mode", "--strict-mcp-config"];
/**
 * Isolation flags of an approved bypass run whose scope sets `repository_config` to `approved` or `enabled` (owner
 * decision 26, Q-37, ADR-0021; Delegated reading). `--restricted` stays absent (as above, ADR-0018) and the Git deny
 * rules, `--tools` and worktree isolation are untouched. Omitting `--safe-mode` is what lets the repository's CLAUDE.md,
 * skills, plugins and hooks load ([HELP]: it "disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom
 * commands/agents"). `approved` keeps `--strict-mcp-config` (no repository MCP definition loads; `--mcp-config` stays
 * barred, ADR-0015); `enabled` omits it so the repository's `.mcp.json` can load. UNVERIFIED (R-41, live check T3.9):
 * that omitting these flags loads exactly those items; [HELP] does not say so.
 */
export const CLAUDE_BYPASS_REPO_CONFIG_ISOLATION_FLAGS: Readonly<Record<"approved" | "enabled", readonly string[]>> = {
  approved: ["--strict-mcp-config"],
  enabled: [],
};
/**
 * Permission flags of an approved bypass run: the bypass flag replaces `--permission-mode dontAsk` (Assumption, see the
 * header); `--permission-prompts none` is kept (nobody answers a prompt, if any remains).
 */
export const CLAUDE_BYPASS_PERMISSION_FLAGS: readonly string[] = [CLAUDE_BYPASS_FLAG, "--permission-prompts", "none"];
/** Network tool named in [HELP] (`--restricted` removes "WebFetch unless --tools names them"); privileged `on` only. */
export const CLAUDE_NETWORK_TOOLS: readonly string[] = ["WebFetch"];

/**
 * Git write deny rules, passed with `--disallowedTools` on every compiled invocation (FR-GIT-01), in the rule form of the
 * [HELP] example `Bash(git *)`. For each subcommand in GIT_WRITE_SUBCOMMANDS: the bare form and the form with
 * arguments; plus every Git global option before the subcommand (GIT_GLOBAL_OPTIONS_WITH_VALUE, GIT_GLOBAL_FLAGS; R-43:
 * `git --no-pager commit` and `git -P commit` still commit) and GitHub CLI pushes. Whether Claude's matcher skips
 * global options when matching `Bash(git commit *)` is unverified (live check C-G2), so the explicit spellings are
 * denied as well. Assumptions (not in [HELP] or [R2]): that `*` matches any suffix (including `=value`) and nothing
 * else; that a deny rule wins over an allow rule; that deny rules naming a tool absent from `--tools` are accepted.
 */
export const CLAUDE_GIT_DENY_RULES: readonly string[] = [
  ...GIT_WRITE_SUBCOMMANDS.flatMap((v) => [`Bash(git ${v})`, `Bash(git ${v} *)`]),
  ...GIT_GLOBAL_OPTIONS_WITH_VALUE.flatMap((o) =>
    o.startsWith("--") ? [`Bash(git ${o} *)`, `Bash(git ${o}=*)`] : [`Bash(git ${o} *)`],
  ),
  ...GIT_GLOBAL_FLAGS.map((o) => `Bash(git ${o} *)`),
  ...GIT_PUBLISHING_PROGRAMS.flatMap((p) => [`Bash(${p})`, `Bash(${p} *)`]),
];

/** FR-GIT-01 declaration for `list_capabilities` and the manifest notes. */
export const CLAUDE_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "provider-deny-rules",
  detail:
    "Layered, all from `claude --help` 2.1.296: (1) no Bash tool in --tools for inspect-untrusted and edit-untrusted " +
    "unless the operator allowlists commands (exact; command prefixes in trusted-development), and any allowlist " +
    "entry that could write Git (commit, ref change, push, config, git global options, gh, command launchers, " +
    "non-read-only subcommands) makes the run Ineligible; " +
    "(2) --disallowedTools Git write deny rules on every invocation (`Bash(git commit)`, `Bash(git commit *)`, ...); " +
    "(3) --restricted with --permission-prompts none denies file-tool writes to git files. Limits: rule matching " +
    "(`*` semantics, deny-over-allow) is an Assumption; deny rules are lexical and cannot see aliases, scripts run by " +
    "an allowlisted build tool, or absolute paths to git; no flag disables Claude's own commit attribution (only " +
    "--bare, unusable). An approved privileged bypass run (--dangerously-skip-permissions) keeps (2) and drops (3) " +
    "(--restricted refuses bypass); whether deny rules hold under bypass is an Assumption (R-26). Live behaviour " +
    "unverified (live smoke test).",
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** Help-text markers the probe requires (FR-ADP-02 steps 3-5). All appear in the installed [HELP]. */
const REQUIRED_HELP: Readonly<Record<"command" | "output_format" | "flags", readonly string[]>> = {
  command: ["--print"],
  output_format: ["--output-format", "stream-json"],
  flags: [
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "--tools",
    "--allowedTools",
    "--disallowedTools",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--resume",
  ],
};

/**
 * Proposed: a shell allowlist entry must be a plain command with plain arguments (no wildcard, no shell
 * metacharacters); see shellRules for the rules it compiles to.
 */
const SHELL_ENTRY = /^[A-Za-z0-9_./-]+( [A-Za-z0-9_./=:@-]+)*$/;
/** Session ids and model names go into argv as option values; refuse anything that could read as an option. */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

export interface ClaudeAdapterOptions {
  /** Absolute path, or a bare name resolved on PATH by `probe`. Default `claude`. */
  binaryPath?: string;
  /** Inserted after argv[0]; for fixture replay in tests only (argv[0] is then node, argv[1] the replay script). */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /**
   * T9.4b (ADR-0029 item 7): the operator opt-in `providers.claude-code.git_channel`. Default false: the adapter
   * declares {@link CLAUDE_GIT_CAPABILITIES} (`none`) and every argv is unchanged. True: it declares
   * {@link CLAUDE_GIT_CHANNEL_CAPABILITIES} (`injected`). Supported, bypass-only (owner decision 2026-10-16, ADR-0033).
   */
  gitChannel?: boolean;
}

function resolveOnPath(name: string): string | undefined {
  if (isAbsolute(name)) return name;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });
/** `isIneligible` for any intermediate result, not only an Invocation. */
const refused = <T extends object>(x: T | Ineligible): x is Ineligible => "ineligible" in x && x.ineligible === true;

/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const CLAUDE_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";
/** Ineligible detail for a scope that sets `bypass` on a run whose `bypassApproved` is false (FR-POL-03). */
export const CLAUDE_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: --dangerously-skip-permissions is compiled only " +
  "for an operator-approved scope (FR-POL-03, LLD §3.1 Bypass, ADR-0017)";

/**
 * T3.5 compile matrix (TDD §4.1.1, Linux), the non-privileged cells that are refused before any argv is built
 * (`privileged` is {@link privilegedPlan}). Every refusal is a specific `Ineligible` (LLD §2); nothing is dropped or
 * downgraded (FR-POL-02). Cells checked in this order, so a profile with several unsupported dimensions reports the
 * first:
 * 1. `bypassApproved` (profile or request) on a non-privileged profile: PROFILE_UNSUPPORTED (FR-POL-03).
 * 2. `test-sandboxed`: PROFILE_UNSUPPORTED whatever its dimensions. [H] (`claude --help` 2.1.296) has no sandbox and
 *    no network option, so FR-POL-06 confinement is not shown (R-10; Q-16 reads FR-POL-06 as covering this profile).
 *    Proposed (fail closed): even the empty-allowlist default is refused, because the native-sandbox cell is
 *    Ineligible for every dimension until T3.9 shows confinement or T3.1 supplies an outer sandbox.
 * 3. A `scoped` dimension outside `privileged`: PROFILE_UNSUPPORTED (only the privileged scope may say `scoped`).
 * 4. `trusted-development` (owner decisions 10-12: operator overrides may loosen it):
 *    - network `allowlist` or `policy`: CAPABILITY_MISSING ([H] has no network or host control; R-36).
 *    - shell `broad` (network `off`): CAPABILITY_MISSING, because nothing in [H] stops a command's network use
 *      (Q-34 Proposed). With rule 4a this means `broad` never compiles for Claude today.
 *    - repository configuration `approved-only` or `allowlisted`: CAPABILITY_MISSING. [H] has no per-item control for
 *      approved hooks or instructions; `--setting-sources` selects whole sources, and `--mcp-config` (approved MCP
 *      servers) is barred by ADR-0015.
 *    What remains compiles as `edit-untrusted` (file access, shell allowlist as command prefixes per ADR-0066, network
 *    off at the tool level, repository configuration disabled with `--safe-mode --restricted --strict-mcp-config`).
 * `inspect-untrusted` and `edit-untrusted` keep their M2 behaviour (T2.2; Q-34: network off at the tool level).
 */
export function matrixIneligible(profile: ResolvedProfile, bypassApproved = false): Ineligible | undefined {
  if (profile.bypassApproved || bypassApproved) {
    return ineligible("PROFILE_UNSUPPORTED", CLAUDE_BYPASS_OUTSIDE_PRIVILEGED);
  }
  if (profile.name === "privileged") {
    return ineligible("PROFILE_UNSUPPORTED", "privileged compiles only through its approved scope (privilegedPlan)");
  }
  if (profile.name === "test-sandboxed") {
    return ineligible(
      "PROFILE_UNSUPPORTED",
      "test-sandboxed: claude --help 2.1.296 documents no per-run sandbox, so FR-POL-06 confinement is not shown " +
        "(R-10, Q-16); awaits the live check T3.9 or an outer sandbox (T3.1)",
    );
  }
  const scoped = (["fileAccess", "shell", "network", "repoConfig"] as const).filter((f) => profile[f] === "scoped");
  if (scoped.length > 0) {
    return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: scoped ${scoped.join(", ")} belongs to privileged only`);
  }
  if (profile.name === "trusted-development") {
    if (profile.network !== "off") {
      return ineligible(
        "CAPABILITY_MISSING",
        `trusted-development network=${profile.network}: claude --help 2.1.296 documents no network or host control ` +
          "(TDD §4.1.1, R-36)",
      );
    }
    if (profile.shell === "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        "trusted-development shell=broad with network=off: claude --help 2.1.296 documents nothing that stops a " +
          "command's network use (Q-34, R-36)",
      );
    }
    if (profile.repoConfig !== "disabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `trusted-development repo_config=${profile.repoConfig}: claude --help 2.1.296 has no per-item control for ` +
          "approved hooks, instructions or MCP servers; --setting-sources selects whole sources and --mcp-config is " +
          "barred by ADR-0015 (TDD §4.1.1)",
      );
    }
    return undefined;
  }
  if (profile.name !== "inspect-untrusted" && profile.name !== "edit-untrusted") {
    return ineligible("PROFILE_UNSUPPORTED", `claude adapter does not support ${String(profile.name)}`);
  }
  return undefined;
}

/** What a profile compiles to before the argv is assembled. */
interface ClaudePlan {
  readonly tools: readonly string[];
  readonly allow: readonly string[];
  /** True only for an approved privileged scope with `bypass: true` (T3.17). */
  readonly bypass: boolean;
  /** Isolation flags of this invocation; defaults to the bypass or non-bypass set when absent. */
  readonly isolation?: readonly string[];
}

/**
 * `Bash` allow rules for an operator shell allowlist, or the specific refusal (FR-GIT-01). The rule syntax
 * `Bash(git *)` is the [HELP] example; the Claude Code permissions page (code.claude.com/docs/en/permissions, read
 * 2026-10-20) says "A rule with no `*` matches one exact command" and that `Bash(ls *)` matches `ls` and `ls -la` but
 * not `lsof`.
 * - `exact` (edit-untrusted, the privileged scope's exact argv entries, LLD §3.1): one `Bash(<entry>)` per entry.
 * - `prefix` (trusted-development, ADR-0066): `Bash(<entry>)` and `Bash(<entry> *)`, so the entry `npx` allows
 *   `npx tsc --noEmit`. An exact rule alone made Claude Code deny every call with arguments under dontAsk (prod runs
 *   run_01M5BST5DB1MXXSRY3DM3KR1KE and run_01M5BST5YTYSQKW0KGPRCWM2F8, Claude Code 2.1.294). An entry whose program is
 *   `git` or a `git-` subprogram stays exact: appended arguments could add a write path (bare `git` passes
 *   gitWriteRisks, `git grep` could gain `-O<cmd>`).
 */
function shellRules(entries: readonly string[], form: "exact" | "prefix" = "exact"): string[] | Ineligible {
  const bad = entries.filter((e) => !SHELL_ENTRY.test(e));
  if (bad.length > 0) {
    return ineligible("PROFILE_UNSUPPORTED", `shell allowlist entries not expressible narrowly: ${bad.join("; ")}`);
  }
  // FR-GIT-01: an allowlisted command that could write Git would leave a Git write permitted.
  const gitWrites = gitWriteRisks(entries);
  if (gitWrites.length > 0) {
    return ineligible(
      "PROFILE_UNSUPPORTED",
      `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => `${g.command} (${g.reason})`).join("; ")}`,
    );
  }
  if (form === "exact") return entries.map((e) => `Bash(${e})`);
  return entries.flatMap((e) => {
    const word = e.split(" ")[0] ?? "";
    const program = word.slice(word.lastIndexOf("/") + 1);
    return program === "git" || program.startsWith("git-") ? [`Bash(${e})`] : [`Bash(${e})`, `Bash(${e} *)`];
  });
}

/** The M2/T3.5 profiles: inspect-untrusted, edit-untrusted and the compilable trusted-development cells. */
function standardPlan(request: CompileRequest, profile: ResolvedProfile): ClaudePlan | Ineligible {
  const matrix = matrixIneligible(profile, request.bypassApproved === true);
  if (matrix !== undefined) return matrix;
  const tools = [...CLAUDE_READ_TOOLS];
  const allow = [...CLAUDE_READ_TOOLS];
  // TDD §4.1.1: trusted-development "Could compile" as edit-untrusted (file access, allowlist shell, network off at the
  // tool level, repository configuration disabled); the cells it cannot compile were refused by matrixIneligible.
  if (profile.name === "edit-untrusted" || profile.name === "trusted-development") {
    if (profile.fileAccess !== "read-only" && request.workspace.writable) {
      tools.push(...CLAUDE_EDIT_TOOLS);
      allow.push(...CLAUDE_EDIT_TOOLS);
    }
    if (profile.shell === "allowlist") {
      // ADR-0066: trusted-development entries are command prefixes; edit-untrusted entries stay exact commands.
      const rules = shellRules(
        profile.shellAllowlist ?? [],
        profile.name === "trusted-development" ? "prefix" : "exact",
      );
      if (refused(rules)) return rules;
      if (rules.length > 0) {
        tools.push("Bash");
        allow.push(...rules);
      }
    } else if (profile.shell !== "none") {
      return ineligible("PROFILE_UNSUPPORTED", `${profile.name} with shell=${profile.shell} is not narrow`);
    }
  } else if (profile.shell !== "none") {
    return ineligible("PROFILE_UNSUPPORTED", "inspect-untrusted must have no shell");
  }
  return { tools, allow, bypass: false };
}

/**
 * The run's `bypassApproved` for a `privileged` compile: `CompileRequest.bypassApproved` or `ResolvedProfile.bypassApproved`
 * (the LLD §2 carrier). Both are set only by the lifecycle from `evaluateBypass` (an `APPROVED`, hash-matching row whose
 * scope sets bypass); the stored snapshot's value is reset to false before dispatch. Proposed (Delegated): either carrier
 * is accepted so the adapter and the lifecycle agree whichever one the lifecycle fills; the argv audit checks again.
 */
export function bypassApprovedFor(request: CompileRequest, profile: ResolvedProfile): boolean {
  return request.bypassApproved === true || profile.bypassApproved === true;
}

/** Proposed: one argv word of a scope allowlist entry; the entry is then joined with spaces into one Bash rule. */
const SCOPE_ARG = /^[A-Za-z0-9_./=:@-]+$/;

/**
 * `privileged` (T3.5, T3.17; TDD §4.1.1 `privileged` column; LLD §3.1; owner decisions 13, 18, 19; Proposed,
 * Delegated). Compiles the approved scope in `profile.privilegedScope.scope` (spellings per `src/policy/scope.ts`).
 * Dimensions are checked in this order and the first that cannot be met is the `Ineligible` reason:
 * 1. No scope binding: PROFILE_UNSUPPORTED.
 * 2. network `off` or `allowlist`: CAPABILITY_MISSING ([HELP] has no network or host control, so a privileged scope's
 *    network limit cannot be enforced, R-36). `on` compiles, naming `WebFetch` in `--tools`.
 * 3. repository_config `approved`: CAPABILITY_MISSING (as trusted-development `approved-only`). `enabled`:
 *    CAPABILITY_MISSING: it means omitting `--safe-mode` and `--restricted`, and without `--restricted` [HELP] documents
 *    no confinement of file tools to the working directory (never beyond the worktree). `disabled` compiles with the
 *    isolation flags. Exception (owner decision 26, Q-37, ADR-0021): in an approved bypass run (`scope.bypass` and
 *    {@link bypassApprovedFor}) `approved` and `enabled` compile with {@link CLAUDE_BYPASS_REPO_CONFIG_ISOLATION_FLAGS}
 *    (no `--safe-mode`; `--strict-mcp-config` kept for `approved`, omitted for `enabled`). A bypass scope without an
 *    approval, and every non-bypass scope, keep the refusal.
 * 4. shell `allowlist` under bypass: CAPABILITY_MISSING ("Bypass all permission checks" [HELP]: allow rules no longer
 *    narrow `Bash`). Otherwise `none` (no `Bash`), `allowlist` (exact `Bash(<argv joined by spaces>)` rules, each word
 *    plain, no Git write), `broad` (`Bash` tool and the allow rule `Bash`).
 * 5. files `read-only` with shell `broad`: CAPABILITY_MISSING (nothing in [HELP] stops a command writing files).
 *    `worktree` adds `Edit,Write` for a writable workspace; `read-only` adds nothing.
 * 6. scope `bypass: true` without an approval ({@link bypassApprovedFor}): PROFILE_UNSUPPORTED (FR-POL-03). With
 *    it, the bypass invocation of the header; `bypass: false` compiles exactly like trusted-development (dontAsk,
 *    `--restricted`).
 * The Git deny rules are on every compiled privileged invocation, bypass or not.
 */
export function privilegedPlan(request: CompileRequest, profile: ResolvedProfile): ClaudePlan | Ineligible {
  const scope: PrivilegedScope | undefined = profile.privilegedScope?.scope;
  if (scope === undefined) {
    return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
  }
  if (scope.network.mode !== "on") {
    return ineligible(
      "CAPABILITY_MISSING",
      `privileged network=${scope.network.mode}: claude --help 2.1.296 documents no network or host control, so only ` +
        "network on compiles (TDD §4.1.1, R-36)",
    );
  }
  const repoMode = scope.repository_config.mode;
  const bypassRepoConfig = scope.bypass && bypassApprovedFor(request, profile);
  if (repoMode === "approved" && !bypassRepoConfig) {
    return ineligible(
      "CAPABILITY_MISSING",
      "privileged repository_config=approved: claude --help 2.1.296 has no per-item control for approved hooks, " +
        "instructions or MCP servers; --mcp-config is barred by ADR-0015 (TDD §4.1.1)",
    );
  }
  if (repoMode === "enabled" && !bypassRepoConfig) {
    return ineligible(
      "CAPABILITY_MISSING",
      "privileged repository_config=enabled: needs omitting --safe-mode and --restricted, and without --restricted " +
        "claude --help 2.1.296 documents no confinement of file tools to the working directory (TDD §4.1.1)",
    );
  }
  const bypass = scope.bypass && bypassApprovedFor(request, profile);
  const tools = [...CLAUDE_READ_TOOLS];
  const allow = [...CLAUDE_READ_TOOLS];
  const shell = scope.shell;
  if (shell.mode === "allowlist") {
    if (scope.bypass) {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged shell=allowlist with bypass: --dangerously-skip-permissions bypasses all permission checks " +
          "(claude --help 2.1.296), so allow rules cannot narrow Bash to the listed commands",
      );
    }
    const bad = shell.allowlist.filter((argv) => !argv.every((w) => SCOPE_ARG.test(w)));
    if (bad.length > 0) {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `privileged shell allowlist entries not expressible as one exact Bash rule: ${bad.map((a) => JSON.stringify(a)).join("; ")}`,
      );
    }
    const rules = shellRules(shell.allowlist.map((argv) => argv.join(" ")));
    if (refused(rules)) return rules;
    tools.push("Bash");
    allow.push(...rules);
  } else if (shell.mode === "broad") {
    if (scope.files.access === "read-only") {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged files=read-only with shell=broad: claude --help 2.1.296 documents nothing that stops a command " +
          "writing files",
      );
    }
    tools.push("Bash");
    allow.push("Bash");
  }
  if (scope.files.access === "worktree" && request.workspace.writable) {
    // Edit tools before Bash, matching the trusted-development order.
    const at = tools.indexOf("Bash");
    tools.splice(at < 0 ? tools.length : at, 0, ...CLAUDE_EDIT_TOOLS);
    const atAllow = allow.findIndex((r) => r === "Bash" || r.startsWith("Bash("));
    allow.splice(atAllow < 0 ? allow.length : atAllow, 0, ...CLAUDE_EDIT_TOOLS);
  }
  tools.push(...CLAUDE_NETWORK_TOOLS);
  allow.push(...CLAUDE_NETWORK_TOOLS);
  if (scope.bypass && !bypass) return ineligible("PROFILE_UNSUPPORTED", CLAUDE_BYPASS_NOT_APPROVED);
  const isolation = bypass && repoMode !== "disabled" ? CLAUDE_BYPASS_REPO_CONFIG_ISOLATION_FLAGS[repoMode] : undefined;
  return isolation === undefined ? { tools, allow, bypass } : { tools, allow, bypass, isolation };
}

/**
 * FR-GIT-02 declaration without the operator opt-in (T9.4, ADR-0026; Delegated): no injected channel, and the compiled
 * argv is unchanged. Q-40 is decided (ADR-0029) and the channel exists behind `providers.claude-code.git_channel`
 * (T9.4b, {@link CLAUDE_GIT_CHANNEL_CAPABILITIES}), for approved bypass runs only (ADR-0033); this default stays
 * because the channel is supported only in that bypass scope (owner decision 2026-10-16), so it stays an explicit
 * operator choice. The detail text is kept as it was.
 */
export const CLAUDE_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "none",
  detail:
    "No injected commit channel: --mcp-config is barred by ADR-0015 and the argv audit until Q-40 is decided, and the " +
    "per-run MCP definition shape, MCP tool allow rules, --safe-mode behaviour and socket reach are unverified (live " +
    "check). Agent work stays in the run's worktree and diff artifacts.",
};

/**
 * Owner decision 41 (ADR-0033; Delegated wording of option A): the Claude channel is offered only to an approved
 * `privileged` run whose scope sets `bypass` ({@link bypassApprovedFor}), the same three facts the argv audit checks.
 * Every other run (inspect-untrusted, edit-untrusted, trusted-development, privileged without bypass) gets no channel,
 * keeps `--safe-mode` and the argv of the opt-in off, and commits through finalize-only (FR-GIT-09, T9.7).
 */
export function claudeChannelOffered(request: CompileRequest, profile: ResolvedProfile): boolean {
  return (
    profile.name === "privileged" &&
    profile.privilegedScope?.scope.bypass === true &&
    bypassApprovedFor(request, profile)
  );
}

/** Ineligible detail of {@link claudeChannelArgs} for a run that is not an approved bypass run (ADR-0033). */
export const CLAUDE_CHANNEL_BYPASS_ONLY =
  "the Claude Code tool channel is offered only to an approved privileged bypass run (owner decision 41, ADR-0033): " +
  "--safe-mode, which every other run keeps, stops the injected MCP server from starting";

/**
 * The fragment {@link CLAUDE_GIT_CHANNEL_CAPABILITIES} appends for one approved bypass run (T9.4b, ADR-0029, ADR-0033;
 * Delegated mechanism):
 *   argv:  `--mcp-config <dir>/mcp-config.json --allowedTools mcp__switchboard-git__commit[ mcp__switchboard-git__push]
 *          [ mcp__switchboard-git__search_project_context]` (one exact rule per offered tool; the read-only search,
 *          T12.9 / FR-RAG-13, only when retrieval is on for the run's project, so otherwise the argv is as before)
 *   removeFlags: `--safe-mode` (owner decision 41; a no-op where decision 26 already omitted it)
 *   env:   exactly `ShimSpec.env` (the token, FR-POL-08: never argv or the file)
 *   file:  `{"mcpServers":{"switchboard-git":{"type":"stdio","command":<ShimSpec.command[0]>,"args":<the rest>,
 *          "env":{"SWITCHBOARD_TOOL_TOKEN":"${SWITCHBOARD_TOOL_TOKEN}"}}}}`, written by the channel service (0600).
 * Live check on the operator's machine (`docs/research/live-checks-2026-10-13.md`, PR #41; Claude Code 2.1.296, a
 * hand-made server, not Switchboard's shim): the `mcpServers` wrapper is required (a bare map is rejected); `${VAR}`
 * expands from the claude environment and an unset one stays literal (so the controller always sets the token and the
 * audit refuses `--mcp-config` without it); the server inherits the whole claude environment (here only PATH, HOME and
 * the token: `envAllowlist`); exact-name allow rules work under `dontAsk`; `--safe-mode` stops the server from
 * starting while `--strict-mcp-config` and `--restricted` do not.
 * Decisions and remaining Assumptions:
 * - Not offered unless {@link claudeChannelOffered} (refused here too, as defence in depth).
 * - `--strict-mcp-config` is NOT added here: the compiled argv already carries it on every invocation except an approved
 *   bypass run with repository_config `enabled` (owner decision 26, ADR-0021), which is exactly ADR-0029 item 5; the
 *   argv audit (`../audit.ts`) refuses `--mcp-config` without it outside that case.
 * - Omitting `--safe-mode` loads the repository's CLAUDE.md, hooks and skills (live check 15, R-41); in a bypass run
 *   that is accepted as part of the deliberately loose bypass (ADR-0033). The Git deny rules, `--tools` and worktree
 *   isolation are unchanged (they held under bypass, live check 14, R-38).
 * - The allow rules are a second `--allowedTools` occurrence at the end of argv. Assumption: repeated occurrences of
 *   this variadic option accumulate. Under `--dangerously-skip-permissions` allow rules do not narrow anything anyway.
 * - The tools are not named in `--tools`: [HELP] says it lists tools "from the built-in set". Assumption: `--tools`
 *   does not filter MCP tools; if it does, the channel tools are simply absent (fail closed).
 * - `--mcp-config` takes "configs..." ([HELP]); the file is followed by `--allowedTools`, so it is the only value.
 */
export function claudeChannelArgs(
  shim: ShimSpec,
  request: CompileRequest,
  profile: ResolvedProfile,
): ChannelArgs | Ineligible {
  if (!claudeChannelOffered(request, profile)) return ineligible("PROFILE_UNSUPPORTED", CLAUDE_CHANNEL_BYPASS_ONLY);
  const [command, ...args] = shim.command;
  if (command === undefined || !isAbsolute(command)) {
    return ineligible("CAPABILITY_MISSING", "tool shim command is not an absolute executable path");
  }
  if (!isAbsolute(shim.dir) || normalize(shim.dir) !== shim.dir) {
    return ineligible("CAPABILITY_MISSING", "tool channel directory is not an absolute, normalised path");
  }
  const tools = [...new Set(shim.toolNames)];
  if (tools.length === 0 || tools.length !== shim.toolNames.length || !tools.every((t) => TOOL_NAMES.includes(t))) {
    return ineligible("CAPABILITY_MISSING", "tool channel offers no tool or an unknown tool");
  }
  const envNames = Object.keys(shim.env);
  if (envNames.length !== 1 || envNames[0] !== TOOL_TOKEN_ENV) {
    return ineligible("CAPABILITY_MISSING", `tool channel environment must be exactly ${TOOL_TOKEN_ENV}`);
  }
  const token = shim.env[TOOL_TOKEN_ENV] ?? "";
  if (token === "" || shim.command.some((a) => a.includes(token))) {
    return ineligible("CAPABILITY_MISSING", "tool channel token is empty or appears in the shim command");
  }
  const definition = {
    mcpServers: {
      [TOOL_SHIM_MCP_SERVER]: {
        type: "stdio",
        command,
        args,
        // A reference, never the value (ADR-0029 item 3).
        env: { [TOOL_TOKEN_ENV]: `\${${TOOL_TOKEN_ENV}}` },
      },
    },
  };
  return {
    argv: ["--mcp-config", join(shim.dir, CHANNEL_MCP_CONFIG_FILE), "--allowedTools", ...tools.map(channelToolRule)],
    env: { ...shim.env },
    files: [{ name: CHANNEL_MCP_CONFIG_FILE, contents: `${JSON.stringify(definition, null, 2)}\n` }],
    removeFlags: [SAFE_MODE_FLAG],
  };
}

/**
 * FR-GIT-02 declaration with the operator opt-in (T9.4b, ADR-0029, ADR-0033; Delegated mechanism, owner decisions 36
 * and 41). `injected` through {@link claudeChannelArgs}, and only for an approved bypass run
 * ({@link claudeChannelOffered} as `offersChannel`); every other run is treated as `none`. No bypass flag is ever added
 * (FR-POL-03). Supported for approved bypass runs only (owner decision 2026-10-16; ADR-0029, ADR-0033); Git-write
 * denial (FR-GIT-01) is unchanged, and the channel is still offered only behind the opt-in.
 */
export const CLAUDE_GIT_CHANNEL_CAPABILITIES: GitCapabilities = {
  commitChannel: "injected",
  detail:
    "Supported, bypass-only operator opt-in (providers.claude-code.git_channel, ADR-0029, ADR-0033; owner decision " +
    "2026-10-16): offered only to an approved privileged bypass run, which then omits --safe-mode (it stops the " +
    "server from starting) and so loads repository CLAUDE.md and hooks; every other run has no channel and keeps " +
    `--safe-mode. The shim is one stdio MCP server "${TOOL_SHIM_MCP_SERVER}" in a controller-written 0600 ` +
    "--mcp-config file in the run's private channel directory, pre-approved by exact name with --allowedTools, token " +
    "only in the environment. Git-write denial (FR-GIT-01) still applies with the server present.",
  channelArgs: (shim, request, profile) => claudeChannelArgs(shim, request, profile),
  offersChannel: (request, profile) => claudeChannelOffered(request, profile),
};

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = CLAUDE_GIT_WRITE_CONTROL;
  /**
   * T5.12 cell 2 (2026-10-17, Claude Code 2.1.294; docs/research/live-checks-2026-10-17-claude.md): session found from
   * a second worktree and from an unrelated empty directory (not tied to cwd), so resumeCwd is `independent`
   * (ADR-0038 item 6.3, LLD §15.6, TDD §4.10).
   */
  readonly resumeCwd = "independent" as const;
  /**
   * T7.12 (FR-RTE-08, Q-90, Delegated): [R2] says the CLI's `--model` accepts model aliases and full model IDs, and the
   * `system` `init` event carries `model` (parse.ts). **Assumption** (to be confirmed by the live conformance subset,
   * FR-OPS-02): that value is a full model ID. Routing still checks the id against the model registry and this
   * adapter's own `compile` (SAFE_VALUE) before it pins one, and keeps the adapter default otherwise.
   */
  readonly reportedModelFlag = {
    kind: "accepted",
    detail: "--model takes aliases and full model IDs ([R2]); init reports the session model (Assumption: a full ID)",
  } as const;
  readonly gitCapabilities: GitCapabilities;
  readonly #configured: string;
  #resolved: string | undefined;
  readonly #launcherArgs: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.gitCapabilities = opts.gitChannel === true ? CLAUDE_GIT_CHANNEL_CAPABILITIES : CLAUDE_GIT_CAPABILITIES;
    this.#configured = opts.binaryPath ?? "claude";
    this.#resolved = isAbsolute(this.#configured) ? this.#configured : undefined;
    this.#launcherArgs = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1-5 via `--version` and `--help` only: no auth, no prompt, no model call. Step 7 (harmless
   * structured-output smoke test) needs a model call, so it is not run here; it belongs to the opt-in live validation
   * (FR-OPS-02). Proposed: the step is omitted rather than reported as passed.
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const path = resolveOnPath(this.#configured);
    if (path === undefined) {
      return {
        binaryPath: this.#configured,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${this.#configured} not found on PATH` }],
      };
    }
    this.#resolved = path;
    const base = [path, ...this.#launcherArgs];
    const ver = await runner([...base, "--version"]);
    const binaryOk = ver.spawnError === undefined && !ver.timedOut && ver.exitCode === 0;
    // Version output is "<semver> (Claude Code)" in the installed binary; only the leading version token is taken.
    const version = binaryOk ? (/^(\d+\.\d+\.\d+[^\s]*)/.exec(ver.stdout.trim())?.[1] ?? null) : null;
    const steps: ProbeResult["steps"] = [
      { step: "binary", ok: binaryOk, ...(ver.spawnError ? { detail: ver.spawnError } : {}) },
      { step: "version", ok: version !== null, ...(version ? { detail: version } : {}) },
    ];
    const help = binaryOk ? await runner([...base, "--help"]) : undefined;
    const helpText = help && help.exitCode === 0 ? help.stdout : "";
    for (const step of ["command", "output_format", "flags"] as const) {
      const missing = REQUIRED_HELP[step].filter((m) => !helpText.includes(m));
      steps.push({
        step,
        ok: helpText !== "" && missing.length === 0,
        ...(missing.length ? { detail: `missing: ${missing.join(", ")}` } : {}),
      });
    }
    return { binaryPath: path, binaryVersion: version, steps };
  }

  /**
   * FR-AUTH-02 via the documented status command `claude auth status` ([R2]: "structured JSON with success/failure
   * exit codes"; `--json` per [HELP]). Switchboard never reads credential files and never runs login.
   * Assumption: exit 0 means logged in and non-zero means not logged in; a `loggedIn: false` field, if present, is
   * also honoured. Anything else (spawn error, timeout, unparseable output) is UNKNOWN, i.e. ineligible.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const path = this.#resolved ?? this.#configured;
    const r = await runner([path, ...this.#launcherArgs, "auth", "status", "--json"]);
    if (r.spawnError !== undefined) return { state: "UNKNOWN", reason: r.spawnError };
    if (r.timedOut) return { state: "UNKNOWN", reason: "auth status timed out" };
    let parsed: Record<string, unknown> | undefined;
    try {
      const v: unknown = JSON.parse(r.stdout);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      // handled below
    }
    if (parsed === undefined) return { state: "UNKNOWN", reason: `unparseable auth status (exit ${r.exitCode})` };
    if (r.exitCode === 0 && parsed.loggedIn !== false) return { state: "OK" };
    if (r.exitCode !== 0 || parsed.loggedIn === false)
      return { state: "AUTH_REQUIRED", loginCommand: CLAUDE_LOGIN_COMMAND };
    return { state: "UNKNOWN", reason: "inconsistent auth status" };
  }

  /**
   * T16.7 (TDD §3.16.1, LLD §19.6, ADR-0056 items 5, 6 and 8): every cell delivers skills as the prompt prefix. A cell
   * may name `native` only with the evidence id of a T16.8 live check; the conformance suite fails one without it.
   */
  skillDelivery(): SkillDelivery {
    return "prompt_prefix";
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /** FR-SES-03: `--resume <session-id>`; [HELP] `--fork-session` (not used) implies resume keeps the same id. */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "claude") {
      return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}, not claude`);
    }
    if (!SAFE_VALUE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a plain identifier");
    }
    return this.#build(request, profile, ["--resume", binding.nativeSessionId]);
  }

  #build(request: CompileRequest, profile: ResolvedProfile, extra: string[]): Invocation | Ineligible {
    // FR-POL-02/03: never downgrade; a bypass flag only for an approved privileged scope (T2.2, T3.5, T3.17).
    const plan = profile.name === "privileged" ? privilegedPlan(request, profile) : standardPlan(request, profile);
    if (refused(plan)) return plan;
    if (this.#resolved === undefined) {
      return ineligible("CAPABILITY_MISSING", "claude binary path unresolved; run probe first");
    }
    if (request.model !== undefined && !SAFE_VALUE.test(request.model)) {
      return ineligible("CAPABILITY_MISSING", "model name is not a plain identifier");
    }

    const policyFlags = [
      ...(plan.isolation ?? (plan.bypass ? CLAUDE_BYPASS_ISOLATION_FLAGS : CLAUDE_ISOLATION_FLAGS)),
      ...(plan.bypass ? CLAUDE_BYPASS_PERMISSION_FLAGS : CLAUDE_PERMISSION_FLAGS),
      "--tools",
      plan.tools.join(","),
      "--allowedTools",
      ...plan.allow,
      // FR-GIT-01: on every invocation, bypass included (whether Claude honours them under bypass: Assumption, R-26).
      "--disallowedTools",
      ...CLAUDE_GIT_DENY_RULES,
    ];
    const argv = [
      this.#resolved,
      ...this.#launcherArgs,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...policyFlags,
      ...(request.model !== undefined ? ["--model", request.model] : []),
      ...extra,
    ];
    return {
      transport: "subprocess-jsonl",
      argv,
      env: {},
      // Assumption: HOME is needed for the CLI to find its own cached login (Switchboard never reads it). No API key
      // variable is ever forwarded (ADR-0003).
      envAllowlist: ["PATH", "HOME"],
      cwd: request.workspace.cwd,
      // Prompt on stdin, not argv, so objective text can never be parsed as a flag. Assumption: `claude -p` reads the
      // prompt from stdin when none is given positionally ([HELP] describes -p as "useful for pipes").
      // FR-RTE-09 (T7.9): constraints first, task text last (`../prompt.ts`).
      stdin: { kind: "text", value: renderPrompt(request) },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport for Claude Code ([R2] adapter matrix)
    return parseClaudeLine(input, state);
  }

  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.find((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const final = events.findLast((e) => e.kind === "result");
    const summary = final?.kind === "result" ? final.summary : undefined;
    const base = {
      unknownEventCount,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(summary ? { summary } : {}),
    };
    const clean =
      exit.outcome === "exited" &&
      exit.exitCode !== null &&
      exit.expectedExitCodes.includes(exit.exitCode) &&
      final?.kind === "result" &&
      final.ok &&
      !events.some(
        (e) => e.kind === "provider_error" || e.kind === "permission_denied" || e.kind === "sandbox_violation",
      );
    if (clean) return { ok: true, ...base };
    const c = this.classifyFailure({
      events,
      exit,
      stderrTail: "",
      timedOut: exit.outcome === "timeout",
      cancelled: exit.outcome === "cancelled",
    });
    return { ok: false, failureCode: c.code, failureDetail: c.detail, ...base };
  }

  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence);
  }
}
