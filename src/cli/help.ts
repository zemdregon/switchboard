/**
 * Per-command help table (FR-OPS-01). One data row per operator command, from which both the global
 * `switchboard --help` output and the per-command `switchboard <command> --help` output render, so a
 * new command without help fails the table-driven test instead of silently shipping without docs.
 * `tool-shim` stays hidden: it is internal (LLD §12.2), not an operator command, and has no row here.
 */

export interface CommandHelpEntry {
  /** Top-level command name as typed on the command line. */
  readonly name: string;
  /** Lines rendered verbatim in the global Commands section (two-space indent included). */
  readonly global: readonly string[];
  /** Usage synopsis lines shown by `switchboard <command> --help`. */
  readonly usage: readonly string[];
  /** One-paragraph summary shown by `switchboard <command> --help`. */
  readonly summary: string;
  /** Option lines relevant to this command (shared text with the global Options section). */
  readonly options: readonly string[];
  /** One example invocation. */
  readonly example: string;
}

const OPT_JSON = "  --json              Machine-readable output (not for serve)";
const OPT_CLIENT = "  --client <id>       serve only: the mcp_clients entry this stdio session is bound to";
const OPT_NOTE = "  --note <text>       skills add, approve and revoke: an operator note of at most 280 characters";
const OPT_CONFIG =
  "  --config <path>     Config file (default: $SWITCHBOARD_CONFIG, then $XDG_CONFIG_HOME/switchboard/config.json)";
const OPT_PROJECT = "  --project <id>      schedule list only: show only this project's schedules";
const OPT_STATE = "  --state <STATE>     runs list only: filter by run state";
const OPT_LIMIT = "  --limit <n>         runs list only: show at most n runs";
const OPT_PROVIDER = "  --provider <id>     capacity only: one provider's capacity";
const OPT_DRY_RUN =
  "  --dry-run           gc only: list what collection would remove, without collecting (the default)";
const OPT_HELP = "  -h, --help          Show this help";
const OPT_APPLY = "  --apply             gc only: collect; refused while serve runs or retention.days is unset";
const OPT_REVISION = "  --revision <n>      projects approve only: the revision to approve (required past the first)";
const OPT_REJECT = "  --reject            projects approve only: reject the revision instead of approving it";
const OPT_ALL = "  --all               skills list only: also list retired names";
const OPT_BODY = "  --body              skills show only: print the version body";
const OPT_FILE = "  --file <path>       skills add only: the skill file to validate and store";
const OPT_FROM_REPOSITORY =
  "  --from-repository   skills add only: the file lives inside a project context or allowed root";

export const COMMAND_HELP: readonly CommandHelpEntry[] = [
  {
    name: "serve",
    global: [
      "  serve --client <id> Run the MCP server on stdin/stdout for one configured MCP client (logs go to stderr)",
    ],
    usage: ["switchboard serve --client <id>"],
    summary: "Run the MCP server on stdin/stdout for one configured MCP client (logs go to stderr).",
    options: [OPT_CLIENT, OPT_CONFIG],
    example: "switchboard serve --client c1",
  },
  {
    name: "doctor",
    global: ["  doctor              Check the environment and probe every registered adapter"],
    usage: ["switchboard doctor [--json]"],
    summary: "Check the environment and probe every registered adapter.",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard doctor",
  },
  {
    name: "runs",
    global: [
      "  runs list           List runs, newest first (--state <STATE>, --limit <n>)",
      "  runs show <id>      Show one run and its events",
      "  runs cancel <id>    Cancel a run (written as an operator record the daemon applies)",
    ],
    usage: [
      "switchboard runs list [--state <STATE>] [--limit <n>]",
      "switchboard runs show <id>",
      "switchboard runs cancel <id>",
    ],
    summary: "List runs newest first, show one run with its events, or cancel a run.",
    options: [OPT_STATE, OPT_LIMIT, OPT_JSON, OPT_CONFIG],
    example: "switchboard runs list --state QUEUED --limit 5",
  },
  {
    name: "capacity",
    global: [
      "  capacity [--provider <id>]",
      "                      Per-provider capacity: controller estimates (score, confidence, throttle risk) with their",
      "                      sources, provider-reported reset and remaining figures when a provider reported them, free",
      "                      slots and breaker state; the same data as the get_capacity MCP tool (read-only)",
    ],
    usage: ["switchboard capacity [--provider <id>]"],
    summary: "Show per-provider capacity: the same estimates and sources as the get_capacity MCP tool (read-only).",
    options: [OPT_PROVIDER, OPT_JSON, OPT_CONFIG],
    example: "switchboard capacity --provider claude",
  },
  {
    name: "affinity",
    global: [
      "  affinity list       List each project's provider affinity: provider, reported model, since when, last switch reason",
      "  affinity reset <project_key>",
      "                      Make the next routing step for the project choose afresh among eligible providers",
      "                      (recorded as user_request); the project key is as affinity list prints it",
    ],
    usage: ["switchboard affinity list", "switchboard affinity reset <project_key>"],
    summary: "List each project's provider affinity, or reset one project so its next run chooses afresh.",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard affinity list",
  },
  {
    name: "index",
    global: [
      "  index status [<project>|global]",
      "                      Retrieval index per store: mode, backend kind and locality, files, chunks, size, revision,",
      "                      complete or incomplete, build time, staleness and pending requests (read-only)",
      "  index rebuild [<project>]",
      "                      Request a full rebuild of a project's index (all projects with retrieval on by default); the",
      "                      serve daemon builds it in the background",
      "  index clear [<project>|global]",
      "                      Delete a store's vectors and chunk text (every store by default); the ledger keeps only counts.",
      "                      Applied at once when serve is not running, else by the daemon",
    ],
    usage: [
      "switchboard index status [<project>|global]",
      "switchboard index rebuild [<project>]",
      "switchboard index clear [<project>|global]",
    ],
    summary: "Inspect the retrieval index, or request a rebuild or clear (applied by the daemon when it runs).",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard index status",
  },
  {
    name: "gc",
    global: [
      "  gc [--apply]        Retention clean-up: dry run by default (lists what would go); --apply collects, and is refused",
      "                      while serve runs or when retention.days is not set in the config",
    ],
    usage: ["switchboard gc [--apply]"],
    summary: "Retention clean-up: dry run by default; --apply collects.",
    options: [OPT_APPLY, OPT_DRY_RUN, OPT_JSON, OPT_CONFIG],
    example: "switchboard gc",
  },
  {
    name: "projects",
    global: [
      "  projects list       List configured and dynamic projects (source config|dynamic; read-only, no lock)",
      "  projects show <id>  Show one project: environment and contexts; for a dynamic project its creator and revisions",
      "  projects approve <id> [--revision <n>] [--reject]",
      "                      Approve (or reject) the revision of a dynamic project that waits for approval; --revision is",
      "                      required once the project has more than one revision (review it with projects show first)",
      "  projects validate [<id>]",
      "                      Check project configuration and repository paths; exit 1 if any check fails",
    ],
    usage: [
      "switchboard projects list",
      "switchboard projects show <id>",
      "switchboard projects approve <id> [--revision <n>] [--reject]",
      "switchboard projects validate [<id>]",
    ],
    summary: "List, show, approve and validate projects (read-only except approve).",
    options: [OPT_REVISION, OPT_REJECT, OPT_JSON, OPT_CONFIG],
    example: "switchboard projects list",
  },
  {
    name: "git",
    global: [
      "  git push <id>       Push a meta-session's published commits (sess_... or one of its run_...) to the context's",
      '                      configured remote branch; only with push.policy "branch", never forced; refused while serve runs',
    ],
    usage: ["switchboard git push <session_or_run_id>"],
    summary: "Push a meta-session's published commits to the context's configured remote branch.",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard git push sess_abc123",
  },
  {
    name: "adapters",
    global: [
      "  adapters validate <provider>",
      "                      Accept the installed version of a provider CLI: runs its probe, status check and conformance",
      "                      checks, including a structured-output smoke test that makes ONE provider call (a trivial",
      "                      read-only prompt; may use your quota). Never starts a sign-in. On success only, writes the",
      "                      version, date, range and an evidence line into the provider's manifest file in the source",
      "                      checkout for you to review and commit; on any failure writes nothing. Exit 1 on failure",
      "  adapters version-canary",
      "                      Compare each enabled provider's installed CLI version to the last recorded value; on change",
      "                      report ADAPTER_VERSION_UNVERIFIED until adapters validate succeeds (for cron or systemd timers)",
    ],
    usage: ["switchboard adapters validate <provider>", "switchboard adapters version-canary"],
    summary: "Accept an installed provider CLI version, or watch for version drift since the last acceptance.",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard adapters validate claude",
  },
  {
    name: "inner",
    global: [
      "  inner status        Show the inner agent: backend, locality, per-task call counts, fallback rates and suspension",
      "                      (read-only; never contacts the backend)",
      "  inner test <task>   Run one task on a built-in synthetic fixture through the configured backend; sends no repository",
      "                      data; exit 1 if the result would fall back",
      "  inner resume <task> Re-enable a task that the quality monitor suspended",
    ],
    usage: ["switchboard inner status", "switchboard inner test <task>", "switchboard inner resume <task>"],
    summary: "Show the inner agent, test one task on a synthetic fixture, or re-enable a suspended task.",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard inner status",
  },
  {
    name: "approve",
    global: [
      "  approve <run_id>    Approve the privileged run that requested an approval (review it with runs show first)",
    ],
    usage: ["switchboard approve <run_id>"],
    summary: "Approve the privileged run that requested an approval (review it with runs show first).",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard approve run_abc123",
  },
  {
    name: "deny",
    global: ["  deny <run_id>       Deny the privileged run that requested an approval; the run ends CANCELLED"],
    usage: ["switchboard deny <run_id>"],
    summary: "Deny the privileged run that requested an approval; the run ends CANCELLED.",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard deny run_abc123",
  },
  {
    name: "pause",
    global: [
      "  pause               Pause every project: no new run is admitted (queued work waits, running runs finish) until",
      "                      resume; applied at once when serve is not running, else by the daemon on its next poll.",
      "                      Operator-only; an MCP client can pause only its own projects (pause_project)",
    ],
    usage: ["switchboard pause"],
    summary: "Pause every project: no new run is admitted until resume (operator-only).",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard pause",
  },
  {
    name: "resume",
    global: [
      "  resume              Lift the operator pause set by pause (a project paused by an MCP client stays paused)",
    ],
    usage: ["switchboard resume"],
    summary: "Lift the operator pause set by pause.",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard resume",
  },
  {
    name: "consent",
    global: [
      "  consent hash-passphrase",
      "                      Read the HTTP consent-page passphrase from stdin and print its hash for",
      "                      transport.http.passphrase_hash (Switchboard's own; touches no provider sign-in)",
      "  consent pair        Print a one-time pairing code for the HTTP consent page (valid once, for 10 minutes)",
    ],
    usage: ["switchboard consent hash-passphrase", "switchboard consent pair"],
    summary: "Manage Switchboard's own HTTP consent-page secrets (never a provider sign-in).",
    options: [OPT_JSON, OPT_CONFIG],
    example: "switchboard consent pair",
  },
  {
    name: "schedule",
    global: [
      "  schedule list [--project <id>]",
      "                      List schedules (read-only, no lock)",
      "  schedule show <sch_id>",
      "                      Show one schedule including cron expression, template and next fire time",
      "  schedule enable <sch_id>",
      "                      Enable a schedule for future cron firing (requires APPROVED status)",
      "  schedule disable <sch_id>",
      "                      Disable a schedule and stop future fires",
      "  schedule approve <sch_id>",
      "                      Approve a widening schedule created by a chat client",
      "  schedule deny <sch_id>",
      "                      Reject a widening schedule",
      "  schedule create <cron> <project> <template_json>",
      "                      Create a new schedule (off by default)",
    ],
    usage: [
      "switchboard schedule list [--project <id>]",
      "switchboard schedule show <sch_id>",
      "switchboard schedule enable <sch_id>",
      "switchboard schedule disable <sch_id>",
      "switchboard schedule approve <sch_id>",
      "switchboard schedule deny <sch_id>",
      "switchboard schedule create <cron> <project> <template_json>",
    ],
    summary: "List, show, enable, disable, approve, deny and create schedules.",
    options: [OPT_PROJECT, OPT_JSON, OPT_CONFIG],
    example: "switchboard schedule list",
  },
  {
    name: "skills",
    global: [
      "  skills list [--all] Skill names with newest version, state, origin, size and hash prefix; --all adds retired names",
      "  skills show <name>[@n] [--body]",
      "                      Metadata and event history; the body only with --body",
      "  skills add <name> --file <path> [--from-repository] [--note <text>]",
      "                      Validate and store a new version (draft) and print <name>@<n>; a source inside a project",
      "                      context or allowed root needs --from-repository and is marked repository_path. A refusal",
      "                      exits 65 with one reason; unchanged content adds no version (exit 0)",
      "  skills approve <name>@<n> [--note <text>]",
      "                      Approve a version for new runs",
      "  skills revoke <name>@<n> [--note <text>]",
      "                      Revoke a version; runs already admitted keep their delivery",
      "  skills retire <name> / skills unretire <name>",
      "                      Retire a name (resolves to nothing for new runs) or lift that",
      "  skills diff <name>@<a> <name>@<b>",
      "                      Line diff of two versions' canonical text",
    ],
    usage: [
      "switchboard skills list [--all]",
      "switchboard skills show <name>[@n] [--body]",
      "switchboard skills add <name> --file <path> [--from-repository] [--note <text>]",
      "switchboard skills approve <name>@<n> [--note <text>]",
      "switchboard skills revoke <name>@<n> [--note <text>]",
      "switchboard skills retire <name> / switchboard skills unretire <name>",
      "switchboard skills diff <name>@<a> <name>@<b>",
    ],
    summary: "List, show, add, approve, revoke, retire and diff operator-authored skill packs.",
    options: [OPT_ALL, OPT_BODY, OPT_FILE, OPT_FROM_REPOSITORY, OPT_NOTE, OPT_JSON, OPT_CONFIG],
    example: "switchboard skills list",
  },
];

/** Top-level command names in help order. */
export function commandNames(): string[] {
  return COMMAND_HELP.map((e) => e.name);
}

/** True for a top-level operator command with a help row (`tool-shim` is internal and has none). */
export function isKnownCommand(name: string): boolean {
  return COMMAND_HELP.some((e) => e.name === name);
}

/**
 * Render `switchboard <command> --help`: the command's usage, options and one example.
 * Returns undefined for an unknown command (the caller reports a usage error listing commands).
 */
export function renderCommandHelp(name: string): string | undefined {
  const entry = COMMAND_HELP.find((e) => e.name === name);
  if (!entry) return undefined;
  const [first, ...rest] = entry.usage;
  const usageLines = [`Usage: ${first ?? ""}`, ...rest.map((u) => `       ${u}`)];
  return [
    ...usageLines,
    "",
    entry.summary,
    "",
    "Options:",
    ...entry.options,
    "",
    "Example:",
    `  ${entry.example}`,
    "",
  ].join("\n");
}

const GLOBAL_OPTIONS: readonly string[] = [
  OPT_JSON,
  OPT_CLIENT,
  OPT_NOTE,
  OPT_CONFIG,
  OPT_PROJECT,
  OPT_STATE,
  OPT_LIMIT,
  OPT_PROVIDER,
  OPT_DRY_RUN,
  OPT_HELP,
];

/** Global `switchboard --help` output, rendered from the table above (a superset of every earlier line). */
export const HELP = [
  "Usage: switchboard <command> [options]",
  "",
  "Commands:",
  ...COMMAND_HELP.flatMap((e) => e.global),
  "",
  "Options:",
  ...GLOBAL_OPTIONS,
  "",
  "Exit codes: 0 success, 1 failure, 2 usage error, 65 skills add refused.",
  "",
].join("\n");
