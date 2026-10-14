/**
 * Operator CLI entry (COMP-OPS, FR-OPS-01, FR-OPS-03). `main` returns the exit code and writes through injected
 * streams so tests call it directly. Exit codes (Proposed): 0 ok, 1 failure, 2 usage error.
 * There is deliberately no `login`/`auth` command (FR-OPS-03, ADR-0003). `serve` (T2.6) is the long-lived daemon: it
 * never writes to stdout itself (MCP framing only, TDD §3.3), so it rejects `--json` and reports every error on stderr.
 */
import { parseArgs } from "node:util";
import { ConfigError } from "../config/index.js";
import { ApprovalRefusedError } from "../lifecycle/approval.js";
import { LockError } from "../lock/index.js";
import { renderValidate, runAdaptersValidate } from "./adapters-validate.js";
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
import { serve } from "./serve.js";

export const HELP = `Usage: switchboard <command> [options]

Commands:
  serve --client <id> Run the MCP server on stdin/stdout for one configured MCP client (logs go to stderr)
  doctor              Check the environment and probe adapters (Claude Code, Codex and the fake test adapter)
  runs list           List runs, newest first (--state <STATE>, --limit <n>)
  runs show <id>      Show one run and its events
  runs cancel <id>    Cancel a run (written as an operator record the daemon applies)
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
  inner status        Show the inner agent: backend, locality, per-task call counts, fallback rates and suspension
                      (read-only; never contacts the backend)
  inner test <task>   Run one task on a built-in synthetic fixture through the configured backend; sends no repository
                      data; exit 1 if the result would fall back
  inner resume <task> Re-enable a task that the quality monitor suspended
  approve <run_id>    Approve the privileged run that requested an approval (review it with runs show first)
  deny <run_id>       Deny the privileged run that requested an approval; the run ends CANCELLED

Options:
  --json              Machine-readable output (not for serve)
  --client <id>       serve only: the mcp_clients entry this stdio session is bound to
  --config <path>     Config file (default: $SWITCHBOARD_CONFIG, then $XDG_CONFIG_HOME/switchboard/config.json)
  -h, --help          Show this help

Exit codes: 0 success, 1 failure, 2 usage error.
`;

const OPTIONS = {
  json: { type: "boolean" },
  config: { type: "string" },
  client: { type: "string" },
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
  state: { type: "string" },
  revision: { type: "string" },
  reject: { type: "boolean" },
  limit: { type: "string" },
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
    if (!(cmd === "projects" && sub === "approve") && (values.revision !== undefined || values.reject)) {
      throw new UsageError("--revision and --reject are only valid with projects approve");
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
      case "doctor": {
        if (sub !== undefined) throw new UsageError("doctor takes no arguments");
        const report = await runDoctor(io, loaderArgv);
        emit(report, renderDoctor(report));
        return report.ok ? 0 : 1;
      }
      case "adapters": {
        // T4.4 (FR-OPS-02): the only subcommand. No lock or ledger; it writes one manifest file, and only on success.
        if (sub !== "validate") {
          throw new UsageError(`unknown adapters subcommand ${JSON.stringify(sub ?? "")}; expected validate`);
        }
        const id = rest[0];
        if (id === undefined || rest.length > 1)
          throw new UsageError("adapters validate requires exactly one provider");
        const report = await runAdaptersValidate(io, id);
        emit(report, renderValidate(report));
        return report.ok ? 0 : 1;
      }
      case "gc": {
        if (sub !== undefined) throw new UsageError("gc takes no positional arguments");
        if (values.apply && values["dry-run"]) throw new UsageError("--apply and --dry-run cannot be combined");
        const report = await runGcCommand(io, loaderArgv, { apply: values.apply === true });
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
          const report = await validateProjects(io, loaderArgv, rest[0]);
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
    : err instanceof UnknownRunError || err instanceof UnknownProjectError
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
