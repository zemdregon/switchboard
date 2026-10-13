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
import { renderDoctor, runDoctor } from "./doctor.js";
import { renderGc, runGcCommand } from "./gc.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";
import { UnknownRunError } from "./operator.js";
import {
  listProjects,
  renderProject,
  renderProjectList,
  renderValidation,
  showProject,
  UnknownProjectError,
  validateProjects,
} from "./projects.js";
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
  projects list       List configured projects (host environments; read-only, no ledger)
  projects show <id>  Show one project: environment and contexts
  projects validate [<id>]
                      Check project configuration and repository paths; exit 1 if any check fails
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
        // T9.1 (FR-PRJ-08): read-only config and filesystem checks; no ledger, no lock.
        if (sub === "list") {
          if (rest.length > 0) throw new UsageError("projects list takes no arguments");
          const projects = listProjects(io, loaderArgv);
          emit({ schema_version: JSON_SCHEMA_VERSION, projects }, renderProjectList(projects));
          return 0;
        }
        if (sub === "show") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("projects show requires exactly one project id");
          const project = showProject(io, loaderArgv, id);
          emit({ schema_version: JSON_SCHEMA_VERSION, project }, renderProject(project));
          return 0;
        }
        if (sub === "validate") {
          if (rest.length > 1) throw new UsageError("projects validate takes at most one project id");
          const report = await validateProjects(io, loaderArgv, rest[0]);
          emit(report, renderValidation(report));
          return report.ok ? 0 : 1;
        }
        throw new UsageError(
          `unknown projects subcommand ${JSON.stringify(sub ?? "")}; expected list, show or validate`,
        );
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
