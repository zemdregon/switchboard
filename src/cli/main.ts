/**
 * Operator CLI entry (COMP-OPS, FR-OPS-01, FR-OPS-03). `main` returns the exit code and writes through injected
 * streams so tests call it directly. Exit codes (Proposed): 0 ok, 1 failure, 2 usage error; `skills add` refusals are 65 (LLD §19.1).
 * There is deliberately no `login`/`auth` command (FR-OPS-03, ADR-0003). `consent` (T13.8) manages only Switchboard's own
 * consent-page passphrase hash and pairing codes for the HTTP transport, never a provider sign-in; `mcp oauth` manages the
 * same embedded authorization server's one-time codes, clients and tokens, also never a provider sign-in. `serve` (T2.6) is the long-lived daemon: it
 * never writes to stdout itself (MCP framing only, TDD §3.3), so it rejects `--json` and reports every error on stderr.
 */
import { parseArgs } from "node:util";
import { ConfigError } from "../config/index.js";
import { DecisionError } from "../control/decisions.js";
import { ApprovalRefusedError } from "../lifecycle/approval.js";
import { LockError } from "../lock/index.js";
import { UnknownOAuthClientError } from "../mcp/oauth-admin.js";
import { renderValidate, runAdaptersValidate } from "./adapters-validate.js";
import { renderAdaptersVersionCanary, runAdaptersVersionCanary } from "./adapters-version-canary.js";
import { listAffinity, renderAffinityList, renderAffinityReset, resetAffinity } from "./affinity.js";
import { renderCapacity, runCapacity } from "./capacity.js";
import { consentHashPassphrase, consentPair, renderPair, renderPassphraseHash } from "./consent.js";
import {
  decideDecision,
  decisionFailureCode,
  listDecisions,
  parseOption,
  renderDecisionDecide,
  renderDecisionList,
} from "./decisions.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { runEvalCommand } from "./eval.js";
import { renderGc, runGcCommand } from "./gc.js";
import { renderGitPush, runGitPush } from "./git-push.js";
import { commandNames, HELP, renderCommandHelp } from "./help.js";
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
import {
  mcpOAuthClient,
  mcpOAuthClients,
  mcpOAuthIssueCode,
  mcpOAuthRevoke,
  mcpOAuthTokens,
  renderClient,
  renderClients,
  renderIssueCode,
  renderRevoke,
  renderTokens,
} from "./mcp-oauth.js";
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
import { renderSecretScanAck, runSecretScanAck, SecretScanAckRefusedError } from "./secret-scan-ack.js";
import { serve } from "./serve.js";
import { runSkillsCommand, UnknownSkillError } from "./skills.js";

export { HELP };

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
  option: { type: "string" },
  "live-budget": { type: "string" },
  "client-profile": { type: "string" },
  ttl: { type: "string" },
  "tokens-only": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * Find the command a `--help`/`-h`/`help` request targets, before any option validation runs, so
 * `switchboard runs --apply --help` prints help instead of a usage error. Returns undefined for the
 * global help, or null when no help was requested.
 */
function findHelpTarget(argv: readonly string[]): string | undefined | null {
  if (argv[0] === "help") {
    const topic = argv[1];
    if (topic === undefined || topic.startsWith("-")) return undefined;
    return topic;
  }
  if (!argv.includes("--help") && !argv.includes("-h")) return null;
  const positional = argv.find((a) => !a.startsWith("-"));
  if (positional === undefined || positional === "help") return undefined;
  return positional;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  run: (argv: readonly string[], io: CliIo) => Promise<number> = main,
): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    // Anything escaping main (import/init failure: main's own try cannot catch those). Exit 1, the
    // internal-error code fail() already uses; no stack unless SWITCHBOARD_DEBUG=1.
    const debug = io.env.SWITCHBOARD_DEBUG === "1";
    const message = err instanceof Error ? err.message : String(err);
    const text = debug && err instanceof Error && err.stack ? err.stack : message;
    io.stderr.write(`switchboard: ${text}\n`);
    return 1;
  }
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === "tool-shim") {
    // T9.4 (FR-GIT-02, LLD §12.2): internal subcommand started by a provider CLI from the per-run MCP definition, not an
    // operator command, so it is not in HELP. It takes its own arguments and touches no config, ledger or lock.
    const { runToolShim } = await import("./tool-shim.js");
    return runToolShim(argv.slice(1), io);
  }
  // Help beats option validation (and unknown-option parse errors): decide before parseArgs runs.
  let json = argv.includes("--json");
  try {
    const helpTarget = findHelpTarget(argv);
    if (helpTarget !== null) {
      if (helpTarget === undefined) {
        io.stdout.write(HELP);
        return 0;
      }
      const text = renderCommandHelp(helpTarget);
      if (text === undefined) {
        throw new UsageError(
          `unknown help topic ${JSON.stringify(helpTarget)}; commands: ${commandNames().join(", ")}`,
        );
      }
      io.stdout.write(text);
      return 0;
    }
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
    const oauthAction = cmd === "mcp" && sub === "oauth" ? rest[0] : undefined;
    if (cmd === "serve") {
      json = false; // stdout belongs to MCP framing; errors go to stderr
      if (values.json) throw new UsageError("serve does not take --json (stdout carries MCP framing only)");
    } else if (values.client !== undefined && oauthAction !== "tokens") {
      throw new UsageError("--client is only valid with serve and mcp oauth tokens");
    }
    if (oauthAction !== "issue-code" && (values["client-profile"] !== undefined || values.ttl !== undefined)) {
      throw new UsageError("--client-profile and --ttl are only valid with mcp oauth issue-code");
    }
    if (oauthAction !== "revoke" && values["tokens-only"]) {
      throw new UsageError("--tokens-only is only valid with mcp oauth revoke");
    }

    if (cmd !== "gc" && (values.apply || values["dry-run"]))
      throw new UsageError("--apply and --dry-run are only valid with gc");
    if (cmd !== "capacity" && cmd !== "eval" && values.provider !== undefined) {
      throw new UsageError("--provider is only valid with capacity and eval run");
    }
    if (cmd !== "eval" && values["live-budget"] !== undefined) {
      throw new UsageError("--live-budget is only valid with eval run");
    }
    if (!(cmd === "projects" && sub === "approve") && (values.revision !== undefined || values.reject)) {
      throw new UsageError("--revision and --reject are only valid with projects approve");
    }

    if (cmd !== "skills" && oauthAction !== "tokens" && values.all) {
      throw new UsageError("--all is only valid with skills and mcp oauth tokens");
    }
    if (cmd !== "skills" && (values.body || values.file !== undefined || values["from-repository"])) {
      throw new UsageError("--body, --file and --from-repository are only valid with skills");
    }
    if (cmd !== "skills" && !(cmd === "decisions" && sub === "decide") && values.note !== undefined) {
      throw new UsageError("--note is only valid with skills and decisions decide");
    }
    if (!(cmd === "decisions" && sub === "decide") && values.option !== undefined) {
      throw new UsageError("--option is only valid with decisions decide");
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
        if (sub === "ack-secret-scan") {
          // T9.14 (FR-GIT-11, LLD §20.9): clears `secret_scan_blocked` for one refusal; never allows a push.
          const pushId = rest[0];
          if (pushId === undefined || rest.length > 1) {
            throw new UsageError("git ack-secret-scan requires exactly one push id (gps_...)");
          }
          const report = runSecretScanAck(io, loaderArgv, pushId);
          emit(report, renderSecretScanAck(report));
          return 0;
        }
        // T9.6 (FR-GIT-05, LLD §12.6, ADR-0028): the operator push; holds the data-directory lock while it runs.
        if (sub !== "push") {
          throw new UsageError(`unknown git subcommand ${JSON.stringify(sub ?? "")}; expected push or ack-secret-scan`);
        }
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
      case "mcp": {
        // The embedded OAuth authorization server of the HTTP transport (ADR-0041): Switchboard's own one-time codes,
        // clients and tokens, never a provider sign-in (FR-OPS-03).
        if (sub !== "oauth")
          throw new UsageError(`unknown mcp subcommand ${JSON.stringify(sub ?? "")}; expected oauth`);
        const [action, ...args] = rest;
        if (action === "issue-code") {
          if (args.length > 0) throw new UsageError("mcp oauth issue-code takes no positional arguments");
          const report = mcpOAuthIssueCode(io, loaderArgv, {
            clientProfile: values["client-profile"],
            ttl: values.ttl,
          });
          emit(report, renderIssueCode(report));
          return 0;
        }
        if (action === "clients") {
          if (args.length > 0) throw new UsageError("mcp oauth clients takes no positional arguments");
          const report = mcpOAuthClients(io, loaderArgv);
          emit(report, renderClients(report));
          return 0;
        }
        if (action === "client") {
          const id = args[0];
          if (id === undefined || args.length > 1)
            throw new UsageError("mcp oauth client requires exactly one client id");
          const report = mcpOAuthClient(io, loaderArgv, id);
          emit(report, renderClient(report));
          return 0;
        }
        if (action === "tokens") {
          if (args.length > 0) throw new UsageError("mcp oauth tokens takes no positional arguments");
          const report = mcpOAuthTokens(io, loaderArgv, {
            ...(values.client !== undefined ? { clientId: values.client } : {}),
            all: values.all === true,
          });
          emit(report, renderTokens(report));
          return 0;
        }
        if (action === "revoke") {
          const id = args[0];
          if (id === undefined || args.length > 1)
            throw new UsageError("mcp oauth revoke requires exactly one client id");
          const report = mcpOAuthRevoke(io, loaderArgv, id, { tokensOnly: values["tokens-only"] === true });
          emit(report, renderRevoke(report));
          return 0;
        }
        throw new UsageError(
          `unknown mcp oauth subcommand ${JSON.stringify(action ?? "")}; expected issue-code, clients, client, tokens or revoke`,
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
            const reason = err instanceof Error ? err.message : String(err);
            throw new UsageError(`invalid JSON in template: ${reason.slice(0, 200)}`);
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
      case "decisions": {
        // T14.15 (FR-CTL-13, FR-OPS-01): list is read-only; decide resolves one open decision as `cli`.
        if (sub === "list") {
          if (rest.length > 0) throw new UsageError("decisions list takes no positional arguments");
          const report = listDecisions(io, loaderArgv, {
            ...(values.project !== undefined ? { projectId: values.project } : {}),
            ...(values.state !== undefined ? { state: values.state } : {}),
          });
          emit(report, renderDecisionList(report));
          return 0;
        }
        if (sub === "decide") {
          const id = rest[0];
          if (id === undefined || rest.length > 1)
            throw new UsageError("decisions decide requires exactly one decision id");
          const report = decideDecision(io, loaderArgv, id, {
            option: parseOption(values.option),
            ...(values.note !== undefined ? { note: values.note } : {}),
          });
          emit(report, renderDecisionDecide(report));
          return 0;
        }
        throw new UsageError(`unknown decisions subcommand ${JSON.stringify(sub ?? "")}; expected list or decide`);
      }
      case "eval": {
        // T8.14 (FR-OPS-06, LLD §20.13): own-repository evaluation; skipped in CI, real providers need a live budget.
        const r = await runEvalCommand(io, loaderArgv, sub, rest, {
          ...(values.provider !== undefined ? { provider: values.provider } : {}),
          ...(values["live-budget"] !== undefined ? { liveBudget: values["live-budget"] } : {}),
        });
        if (json) io.stdout.write(`${JSON.stringify(r.data, null, 2)}\n`);
        else (r.code === 0 ? io.stdout : io.stderr).write(r.text);
        return r.code;
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
  const base = usage
    ? "USAGE"
    : err instanceof UnknownRunError ||
        err instanceof UnknownProjectError ||
        err instanceof UnknownScheduleError ||
        err instanceof UnknownSkillError ||
        err instanceof UnknownOAuthClientError
      ? "NOT_FOUND"
      : err instanceof ApprovalRefusedError || err instanceof SecretScanAckRefusedError
        ? "REFUSED"
        : err instanceof ConfigError
          ? "CONFIG"
          : err instanceof LockError
            ? "LOCKED"
            : "ERROR";
  // T14.15: an unknown decision is NOT_FOUND, a second decision CONFLICT, any other refusal REFUSED.
  const code = err instanceof DecisionError ? decisionFailureCode(err) : base;
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
