/**
 * Operator CLI entry (COMP-OPS, FR-OPS-01, FR-OPS-03). `main` returns the exit code and writes through injected
 * streams so tests call it directly. Exit codes (Proposed): 0 ok, 1 failure, 2 usage error; `skills add` refusals are 65 (LLD §19.1).
 * There is deliberately no `login`/`auth` command (FR-OPS-03, ADR-0003). `consent` (T13.8) manages only Switchboard's own
 * consent-page passphrase hash and pairing codes for the HTTP transport, never a provider sign-in. `serve` (T2.6) is the long-lived daemon: it
 * never writes to stdout itself (MCP framing only, TDD §3.3), so it rejects `--json` and reports every error on stderr.
 */
import { parseArgs } from "node:util";
import { ConfigError } from "../config/index.js";
import { ApprovalRefusedError } from "../lifecycle/approval.js";
import { LockError } from "../lock/index.js";
import { renderValidate, runAdaptersValidate } from "./adapters-validate.js";
import { renderAdaptersVersionCanary, runAdaptersVersionCanary } from "./adapters-version-canary.js";
import { listAffinity, renderAffinityList, renderAffinityReset, resetAffinity } from "./affinity.js";
import { renderCapacity, runCapacity } from "./capacity.js";
import { consentHashPassphrase, consentPair, renderPair, renderPassphraseHash } from "./consent.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { renderGc, runGcCommand } from "./gc.js";
import { renderGitPush, runGitPush } from "./git-push.js";
import {
  innerResume,
  innerStatus,
  innerTest,
  parseInnerTask,
  renderInnerResume,
  renderInnerStatus,
  renderInnerTest,
} from "./inner.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";
import { UnknownRunError } from "./operator.js";
import { pauseAll, renderPause } from "./pause.js";
import { renderProject, renderValidation, UnknownProjectError, validateProjects } from "./projects.js";
import {
  approveProject,
  listAllProjects,
  parseRevision,
  renderAllProjects,
  renderDynamicDetail,
  renderProjectApproval,
  showAnyProject,
} from "./projects-dynamic.js";
import { indexRequest, indexStatus, renderIndexRequest, renderIndexStatus } from "./rag-index.js";
import {
  cancelRun,
  decideRun,
  listRuns,
  parseLimit,
  renderCancel,
  renderDecision,
  renderRun,
  renderRunList,
  showRun,
} from "./runs.js";
import {
  approveSchedule,
  createSchedule,
  denySchedule,
  disableSchedule,
  enableSchedule,
  listSchedules,
  renderScheduleDetail,
  renderScheduleList,
  renderScheduleMutation,
  showSchedule,
  UnknownScheduleError,
} from "./schedule.js";
import { serve } from "./serve.js";
import { runSkillsCommand, UnknownSkillError } from "./skills.js";

export const HELP = `Usage: switchboard <command> [options]

Commands:
  serve --client <id> Run the MCP server on stdin/stdout for one configured MCP client (logs go to stderr)
  doctor              Check the environment and probe adapters (Claude Code, Codex and the fake test adapter)
  runs list           List runs, newest first (--state <STATE>, --limit <n>)
  runs show <id>      Show one run and its events
  runs cancel <id>    Cancel a run (written as an operator record the daemon applies)
  capacity [--provider <id>]
                      Per-provider capacity: controller estimates (score, confidence, throttle risk) with their
                      sources, provider-reported reset and remaining figures when a provider reported them, free
                      slots and breaker state; the same data as the get_capacity MCP tool (read-only)
  affinity list       List each project's provider affinity: provider, reported model, since when, last switch reason
  affinity reset <project_key>
                      Make the next routing step for the project choose afresh among eligible providers
                      (recorded as user_request); the project key is as affinity list prints it
  index status [<project>|global]
                      Retrieval index per store: mode, backend kind and locality, files, chunks, size, revision,
                      complete or incomplete, build time, staleness and pending requests (read-only)
  index rebuild [<project>]
                      Request a full rebuild of a project's index (all projects with retrieval on by default); the
                      serve daemon builds it in the background
  index clear [<project>|global]
                      Delete a store's vectors and chunk text (every store by default); the ledger keeps only counts.
                      Applied at once when serve is not running, else by the daemon
  gc [--apply]        Retention clean-up: dry run by default (lists what would go); --apply collects, and is refused
                      while serve runs or when retention.days is not set in the config
  projects list       List configured and dynamic projects (source config|dynamic; read-only, no lock)
  projects show <id>  Show one project: environment and contexts; for a dynamic project its creator and revisions
  projects approve <id> [--revision <n>] [--reject]
                      Approve (or reject) the revision of a dynamic project that waits for approval; --revision is
                      required once the project has more than one revision (review it with projects show first)
  projects validate [<id>]
                      Check project configuration and repository paths; exit 1 if any check fails
  git push <id>       Push a meta-session's published commits (sess_... or one of its run_...) to the context's
                      configured remote branch; only with push.policy "branch", never forced; refused while serve runs
  adapters validate <provider>
                      Accept the installed version of a provider CLI: runs its probe, status check and conformance
                      checks, including a structured-output smoke test that makes ONE provider call (a trivial
                      read-only prompt; may use your quota). Never starts a sign-in. On success only, writes the
                      version, date, range and an evidence line into the provider's manifest file in the source
                      checkout for you to review and commit; on any failure writes nothing. Exit 1 on failure
  adapters version-canary
                      Compare each enabled provider's installed CLI version to the last recorded value; on change
                      report ADAPTER_VERSION_UNVERIFIED until adapters validate succeeds (for cron or systemd timers)
  inner status        Show the inner agent: backend, locality, per-task call counts, fallback rates and suspension
                      (read-only; never contacts the backend)
  inner test <task>   Run one task on a built-in synthetic fixture through the configured backend; sends no repository
                      data; exit 1 if the result would fall back
  inner resume <task> Re-enable a task that the quality monitor suspended
  approve <run_id>    Approve the privileged run that requested an approval (review it with runs show first)
  deny <run_id>       Deny the privileged run that requested an approval; the run ends CANCELLED
  pause               Pause every project: no new run is admitted (queued work waits, running runs finish) until
                      resume; applied at once when serve is not running, else by the daemon on its next poll.
                      Operator-only; an MCP client can pause only its own projects (pause_project)
  resume              Lift the operator pause set by pause (a project paused by an MCP client stays paused)
  consent hash-passphrase
                      Read the HTTP consent-page passphrase from stdin and print its hash for
                      transport.http.passphrase_hash (Switchboard's own; touches no provider sign-in)
  consent pair        Print a one-time pairing code for the HTTP consent page (valid once, for 10 minutes)
  schedule list [--project <id>]
                      List schedules (read-only, no lock)
  schedule show <sch_id>
                      Show one schedule including cron expression, template and next fire time
  schedule enable <sch_id>
                      Enable a schedule for future cron firing (requires APPROVED status)
  schedule disable <sch_id>
                      Disable a schedule and stop future fires
  schedule approve <sch_id>
                      Approve a widening schedule created by a chat client
  schedule deny <sch_id>
                      Reject a widening schedule
  schedule create <cron> <project> <template_json>
                      Create a new schedule (off by default)
  skills list [--all] Skill names with newest version, state, origin, size and hash prefix; --all adds retired names
  skills show <name>[@n] [--body]
                      Metadata and event history; the body only with --body
  skills add <name> --file <path> [--from-repository] [--note <text>]
                      Validate and store a new version (draft) and print <name>@<n>; a source inside a project
                      context or allowed root needs --from-repository and is marked repository_path. A refusal
                      exits 65 with one reason; unchanged content adds no version (exit 0)
  skills approve <name>@<n> [--note <text>]
                      Approve a version for new runs
  skills revoke <name>@<n> [--note <text>]
                      Revoke a version; runs already admitted keep their delivery
  skills retire <name> / skills unretire <name>
                      Retire a name (resolves to nothing for new runs) or lift that
  skills diff <name>@<a> <name>@<b>
                      Line diff of two versions' canonical text

Options:
  --json              Machine-readable output (not for serve)
  --client <id>       serve only: the mcp_clients entry this stdio session is bound to
  --note <text>       skills add, approve and revoke: an operator note of at most 280 characters
  --config <path>     Config file (default: $SWITCHBOARD_CONFIG, then $XDG_CONFIG_HOME/switchboard/config.json)
  -h, --help          Show this help

Exit codes: 0 success, 1 failure, 2 usage error, 65 skills add refused.
`;

const OPTIONS = {
  json: { type: "boolean" },
  config: { type: "string" },
  client: { type: "string" },
  project: { type: "string" },
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
  state: { type: "string" },
  revision: { type: "string" },
  reject: { type: "boolean" },
  limit: { type: "string" },
  provider: { type: "string" },
  all: { type: "boolean" },
  body: { type: "boolean" },
  file: { type: "string" },
  "from-repository": { type: "boolean" },
  note: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === "tool-shim") {
    // T9.4 (FR-GIT-02, LLD §12.2): internal subcommand started by a provider CLI from the per-run MCP definition, not an
    // operator command, so it is not in HELP. It takes its own arguments and touches no config, ledger or lock.
    const { runToolShim } = await import("./tool-shim.js");
    return runToolShim(argv.slice(1), io);
  }
  let json = argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    json = values.json === true;
    // Re-pass the config flag to the loader in the form it parses.
    const loaderArgv = values.config !== undefined ? ["--config", values.config] : [];
    const [cmd, sub, ...rest] = positionals;
    if (cmd === "serve") {
      json = false; // stdout belongs to MCP framing; errors go to stderr
      if (values.json) throw new UsageError("serve does not take --json (stdout carries MCP framing only)");
    } else if (values.client !== undefined) {
      throw new UsageError("--client is only valid with serve");
    }

    if (cmd !== "gc" && (values.apply || values["dry-run"]))
      throw new UsageError("--apply and --dry-run are only valid with gc");
    if (cmd !== "capacity" && values.provider !== undefined) {
      throw new UsageError("--provider is only valid with capacity");
    }
    if (!(cmd === "projects" && sub === "approve") && (values.revision !== undefined || values.reject)) {
      throw new UsageError("--revision and --reject are only valid with projects approve");
    }

    if (
      cmd !== "skills" &&
      (values.all || values.body || values.file !== undefined || values["from-repository"] || values.note !== undefined)
    ) {
      throw new UsageError("--all, --body, --file, --from-repository and --note are only valid with skills");
    }

    if (values.help) {
      io.stdout.write(HELP);
      return 0;
    }
    if (cmd === undefined) {
      io.stderr.write(HELP);
      return 2;
    }

    const emit = (data: unknown, text: string) => io.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : text);

    switch (cmd) {
      case "serve": {
        if (sub !== undefined) throw new UsageError("serve takes no positional arguments");
        if (values.client === undefined || values.client === "") {
          throw new UsageError("serve requires --client <id> naming an mcp_clients entry in the config");
        }
        return await serve(io, { clientId: values.client, loaderArgv });
      }
      case "capacity": {
        if (sub !== undefined) throw new UsageError("capacity takes no positional arguments");
        const projection = runCapacity(io, loaderArgv, values.provider);
        emit({ schema_version: JSON_SCHEMA_VERSION, ...projection }, renderCapacity(projection));
        return 0;
      }
      case "affinity": {
        // T7.7 (FR-RTE-07, LLD §17.6): list is read-only; reset writes two columns of one existing row.
        if (sub === "list") {
          if (rest.length > 0) throw new UsageError("affinity list takes no arguments");
          const report = listAffinity(io, loaderArgv);
          emit(report, renderAffinityList(report));
          return 0;
        }
        if (sub === "reset") {
          const key = rest[0];
          if (key === undefined || rest.length > 1)
            throw new UsageError("affinity reset requires exactly one project key");
          const report = resetAffinity(io, loaderArgv, key);
          emit(report, renderAffinityReset(report));
          return 0;
        }
        throw new UsageError(`unknown affinity subcommand ${JSON.stringify(sub ?? "")}; expected list or reset`);
      }
      case "index": {
        // T12.4 (FR-RAG-11, FR-RAG-14, LLD §14.5): status is read-only; rebuild and clear write operator records.
        if (rest.length > 1) throw new UsageError(`index ${sub ?? ""} takes at most one project id or global`);
        if (sub === "status") {
          const report = await indexStatus(io, loaderArgv, rest[0]);
          emit(report, renderIndexStatus(report));
          return 0;
        }
        if (sub === "rebuild" || sub === "clear") {
          const report = indexRequest(io, loaderArgv, sub, rest[0]);
          emit(report, renderIndexRequest(report));
          return 0;
        }
        throw new UsageError(
          `unknown index subcommand ${JSON.stringify(sub ?? "")}; expected status, rebuild or clear`,
        );
      }
      case "doctor": {
        if (sub !== undefined) throw new UsageError("doctor takes no arguments");
        const report = await runDoctor(io, loaderArgv);
        emit(report, renderDoctor(report));
        return report.ok ? 0 : 1;
      }
      case "adapters": {
        if (sub === "validate") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("adapters validate requires exactly one provider");
          const report = await runAdaptersValidate(io, id, loaderArgv);
          emit(report, renderValidate(report));
          return report.ok ? 0 : 1;
        }
        if (sub === "version-canary") {
          if (rest.length > 0) throw new UsageError("adapters version-canary takes no arguments");
          const report = await runAdaptersVersionCanary(io, loaderArgv);
          emit(report, renderAdaptersVersionCanary(report));
          return report.ok ? 0 : 1;
        }
        throw new UsageError(
          `unknown adapters subcommand ${JSON.stringify(sub ?? "")}; expected validate or version-canary`,
        );
      }
      case "gc": {
        if (sub !== undefined) throw new UsageError("gc takes no positional arguments");
        if (values.apply && values["dry-run"]) throw new UsageError("--apply and --dry-run cannot be combined");
        const report = await runGcCommand(io, loaderArgv, {
          apply: values.apply === true,
          ...(io.containerRuntime !== undefined ? { makeRuntime: io.containerRuntime } : {}),
        });
        emit(report, renderGc(report));
        return report.errors && report.errors.length > 0 ? 1 : 0;
      }
      case "runs": {
        if (sub === "list") {
          if (rest.length > 0) throw new UsageError("runs list takes no arguments");
          const runs = listRuns(io, loaderArgv, { state: values.state, limit: parseLimit(values.limit) });
          emit({ schema_version: JSON_SCHEMA_VERSION, runs }, renderRunList(runs));
          return 0;
        }
        if (sub === "show" || sub === "cancel") {
          const id = rest[0];
          if (id === undefined || rest.length > 1) throw new UsageError(`runs ${sub} requires exactly one run id`);
          if (sub === "show") {
            const detail = showRun(io, loaderArgv, id);
            if (!detail) throw new UnknownRunError(`unknown run ${id}`);
            emit({ schema_version: JSON_SCHEMA_VERSION, ...detail }, renderRun(detail));
            return 0;
          }
          const report = cancelRun(io, loaderArgv, id);
          emit(report, renderCancel(report));
          return 0;
        }
        throw new UsageError(`unknown runs subcommand ${JSON.stringify(sub ?? "")}; expected list, show or cancel`);
      }
      case "projects": {
        // T9.1 (FR-PRJ-08): read-only config and filesystem checks, no lock. T9.9: list and show also read the
        // dynamic projects from the ledger (read-only); approve writes one decision row (FR-PRJ-10, ADR-0030).
        if (sub === "list") {
          if (rest.length > 0) throw new UsageError("projects list takes no arguments");
          const projects = listAllProjects(io, loaderArgv);
          emit({ schema_version: JSON_SCHEMA_VERSION, projects }, renderAllProjects(projects));
          return 0;
        }
        if (sub === "show") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("projects show requires exactly one project id");
          const { project, revisions } = showAnyProject(io, loaderArgv, id);
          emit(
            { schema_version: JSON_SCHEMA_VERSION, project, ...(revisions ? { revisions } : {}) },
            renderProject(project) + renderDynamicDetail(project, revisions),
          );
          return 0;
        }
        if (sub === "approve") {
          const id = rest[0];
          if (id === undefined || rest.length > 1) {
            throw new UsageError("projects approve requires exactly one project id");
          }
          const report = approveProject(io, loaderArgv, id, {
            ...(values.revision !== undefined ? { revision: parseRevision(values.revision) as number } : {}),
            reject: values.reject === true,
          });
          emit(report, renderProjectApproval(report));
          return 0;
        }
        if (sub === "validate") {
          if (rest.length > 1) throw new UsageError("projects validate takes at most one project id");
          const report = await validateProjects(io, loaderArgv, rest[0], {
            ...(io.containerRuntime !== undefined ? { makeRuntime: io.containerRuntime } : {}),
          });
          emit(report, renderValidation(report));
          return report.ok ? 0 : 1;
        }
        throw new UsageError(
          `unknown projects subcommand ${JSON.stringify(sub ?? "")}; expected list, show, validate or approve`,
        );
      }
      case "git": {
        // T9.6 (FR-GIT-05, LLD §12.6, ADR-0028): the operator push; holds the data-directory lock while it runs.
        if (sub !== "push") throw new UsageError(`unknown git subcommand ${JSON.stringify(sub ?? "")}; expected push`);
        const id = rest[0];
        if (id === undefined || rest.length > 1) {
          throw new UsageError("git push requires exactly one meta-session or run id");
        }
        const report = await runGitPush(io, loaderArgv, id);
        emit(report, renderGitPush(report));
        return report.pushed ? 0 : 1;
      }
      case "inner": {
        // T11.7 (FR-INN-17, LLD §13): status reads the ledger only; test sends the built-in fixture; resume re-enables.
        if (sub === "status") {
          if (rest.length > 0) throw new UsageError("inner status takes no arguments");
          const report = innerStatus(io, loaderArgv);
          emit(report, renderInnerStatus(report));
          return 0;
        }
        if (sub === "test" || sub === "resume") {
          if (rest.length !== 1) throw new UsageError(`inner ${sub} requires exactly one task`);
          const task = parseInnerTask(rest[0]);
          if (sub === "resume") {
            const report = await innerResume(io, loaderArgv, task);
            emit(report, renderInnerResume(report));
            return 0;
          }
          const report = await innerTest(io, loaderArgv, task);
          emit(report, renderInnerTest(report));
          return report.accepted ? 0 : 1;
        }
        throw new UsageError(`unknown inner subcommand ${JSON.stringify(sub ?? "")}; expected status, test or resume`);
      }
      case "approve":
      case "deny": {
        // T3.4 (FR-OPS-02, FRD WF-7): top-level operator commands; no MCP tool can approve (FR-MCP-06).
        if (sub === undefined || rest.length > 0) throw new UsageError(`${cmd} requires exactly one run id`);
        const report = decideRun(io, loaderArgv, sub, cmd === "approve" ? "APPROVED" : "DENIED");
        emit(report, renderDecision(report));
        return 0;
      }
      case "pause":
      case "resume": {
        // T14.6 (FR-CTL-05, FR-OPS-01): the operator's global pause; no MCP tool pauses more than its own projects.
        if (sub !== undefined) throw new UsageError(`${cmd} takes no arguments`);
        const report = pauseAll(io, loaderArgv, cmd);
        emit(report, renderPause(report));
        return 0;
      }
      case "consent": {
        // T13.8 (ADR-0041 item 3, Q-75, Q-76): Switchboard's own consent-page secrets, never a provider sign-in.
        if (rest.length > 0) throw new UsageError(`consent ${sub ?? ""} takes no arguments`);
        if (sub === "hash-passphrase") {
          const report = await consentHashPassphrase(io);
          emit(report, renderPassphraseHash(report));
          return 0;
        }
        if (sub === "pair") {
          const report = consentPair(io, loaderArgv);
          emit(report, renderPair(report));
          return 0;
        }
        throw new UsageError(
          `unknown consent subcommand ${JSON.stringify(sub ?? "")}; expected hash-passphrase or pair`,
        );
      }
      case "schedule": {
        // T15.2 (FR-QUE-02, FR-OPS-01): schedules list, show, enable, disable, approve, deny, create.
        if (sub === "list") {
          if (rest.length > 0) throw new UsageError("schedule list takes no positional arguments");
          const report = listSchedules(io, loaderArgv, {
            ...(values.project !== undefined ? { projectId: values.project } : {}),
          });
          emit(report, renderScheduleList(report));
          return 0;
        }
        if (sub === "show") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("schedule show requires exactly one schedule id");
          const report = showSchedule(io, loaderArgv, id);
          emit(report, renderScheduleDetail(report));
          return 0;
        }
        if (sub === "enable") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("schedule enable requires exactly one schedule id");
          const report = enableSchedule(io, loaderArgv, id);
          emit(report, renderScheduleMutation(report));
          return 0;
        }
        if (sub === "disable") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("schedule disable requires exactly one schedule id");
          const report = disableSchedule(io, loaderArgv, id);
          emit(report, renderScheduleMutation(report));
          return 0;
        }
        if (sub === "approve") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("schedule approve requires exactly one schedule id");
          const report = approveSchedule(io, loaderArgv, id);
          emit(report, renderScheduleMutation(report));
          return 0;
        }
        if (sub === "deny") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("schedule deny requires exactly one schedule id");
          const report = denySchedule(io, loaderArgv, id);
          emit(report, renderScheduleMutation(report));
          return 0;
        }
        if (sub === "create") {
          if (rest.length < 3) throw new UsageError("schedule create requires <cron> <project> <template_json>");
          const cronExpr = rest[0] ?? "";
          const projectId = rest[1] ?? "";
          const rawTemplate = rest.slice(2).join(" ");
          let template: unknown;
          try {
            template = JSON.parse(rawTemplate);
          } catch (err) {
            throw new UsageError(`invalid template JSON: ${String(err)}`);
          }
          const report = createSchedule(io, loaderArgv, {
            projectId,
            cronExpr,
            template,
            enabled: values.apply === true,
          });
          emit(report, renderScheduleMutation(report));
          return 0;
        }
        throw new UsageError(
          `unknown schedule subcommand ${JSON.stringify(sub ?? "")}; expected list, show, enable, disable, approve, deny or create`,
        );
      }
      case "skills": {
        // T16.2 (FR-SKL-09, LLD §19.10): operator records and the content file only (ADR-0005).
        const r = runSkillsCommand(io, loaderArgv, sub, rest, {
          all: values.all === true,
          body: values.body === true,
          fromRepository: values["from-repository"] === true,
          ...(values.file !== undefined ? { file: values.file } : {}),
          ...(values.note !== undefined ? { note: values.note } : {}),
        });
        if (json) io.stdout.write(`${JSON.stringify(r.data, null, 2)}\n`);
        else (r.code === 0 ? io.stdout : io.stderr).write(r.text);
        return r.code;
      }
      default:
        throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
    }
  } catch (err) {
    return fail(err, io, json);
  }
}

function fail(err: unknown, io: CliIo, json: boolean): number {
  const usage = err instanceof UsageError || isParseArgsError(err);
  const code = usage
    ? "USAGE"
    : err instanceof UnknownRunError ||
        err instanceof UnknownProjectError ||
        err instanceof UnknownScheduleError ||
        err instanceof UnknownSkillError
      ? "NOT_FOUND"
      : err instanceof ApprovalRefusedError
        ? "REFUSED"
        : err instanceof ConfigError
          ? "CONFIG"
          : err instanceof LockError
            ? "LOCKED"
            : "ERROR";
  const message = err instanceof Error ? err.message : String(err);
  if (json)
    io.stdout.write(`${JSON.stringify({ schema_version: JSON_SCHEMA_VERSION, error: { code, message } }, null, 2)}\n`);
  else io.stderr.write(`switchboard: ${message}\n${usage ? "Run 'switchboard --help' for usage.\n" : ""}`);
  return usage ? 2 : 1;
}

function isParseArgsError(err: unknown): boolean {
  return (
    typeof (err as { code?: unknown })?.code === "string" && (err as { code: string }).code.startsWith("ERR_PARSE_ARGS")
  );
}
