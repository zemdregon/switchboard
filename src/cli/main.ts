/**
 * Operator CLI entry (COMP-OPS, FR-OPS-01, FR-OPS-03). `main` returns the exit code and writes through injected
 * streams so tests call it directly. Exit codes (Proposed): 0 ok, 1 failure, 2 usage error.
 * There is deliberately no `login`/`auth` command (FR-OPS-03, ADR-0003); `serve` arrives in M2.
 */
import { parseArgs } from "node:util";
import { ConfigError } from "../config/index.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";
import { UnknownRunError } from "./operator.js";
import { cancelRun, listRuns, parseLimit, renderCancel, renderRun, renderRunList, showRun } from "./runs.js";

export const HELP = `Usage: switchboard <command> [options]

Commands:
  doctor              Check the environment and probe adapters (fake adapter only in M1)
  runs list           List runs, newest first (--state <STATE>, --limit <n>)
  runs show <id>      Show one run and its events
  runs cancel <id>    Cancel a run (written as an operator record the daemon applies)

Options:
  --json              Machine-readable output
  --config <path>     Config file (default: $SWITCHBOARD_CONFIG, then $XDG_CONFIG_HOME/switchboard/config.json)
  -h, --help          Show this help

Exit codes: 0 success, 1 failure, 2 usage error.
`;

const OPTIONS = {
  json: { type: "boolean" },
  config: { type: "string" },
  state: { type: "string" },
  limit: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
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
      case "doctor": {
        if (sub !== undefined) throw new UsageError("doctor takes no arguments");
        const report = await runDoctor(io, loaderArgv);
        emit(report, renderDoctor(report));
        return report.ok ? 0 : 1;
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
    : err instanceof UnknownRunError
      ? "NOT_FOUND"
      : err instanceof ConfigError
        ? "CONFIG"
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
