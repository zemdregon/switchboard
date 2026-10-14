#!/usr/bin/env node
// Fake provider CLI for tests (T1.7, TDD §3.6). Needs no real provider, network or credentials.
// Usage: cli.mjs [--scenario NAME] [--resume SESSION_ID] [--version | --auth-status | --smoke]
// Scenarios: success, task_failure, auth_missing, rate_limit, partial_mutation, malformed_output, hang,
// hang_ignore_term, env_report, git_commit, git_attempts, edit_files. The prompt, if any, arrives on stdin and is ignored except by git_commit.
// `env_report` lists the NAMES (never the values) of the environment variables the child received, for the
// environment-allowlist test (T3.8, FR-EXE-07).
//
// `git_commit` (T9.4, FR-GIT-02) plays an agent that uses the injected tool channel: `--tool-channel <json>` names the
// shim command (`{"command": [...]}`) and the token arrives in SWITCHBOARD_TOOL_TOKEN. The objective on stdin may be a
// JSON plan `{"files": {"<rel path>": "<content>"}, "calls": [{"name": "commit"|"push", "arguments": {...}}]}`; otherwise a
// default plan writes feature.txt and commits it with a message that carries an attribution trailer. Each call's
// outcome is reported as a `message` event (SHA or error code only; never the token). Tool errors do not fail the run.
//
// `git_attempts` (T9.5, FR-GIT-03) plays an agent that writes to Git by itself with PLAIN Git commands, run in its
// working directory (the run worktree) against temporary local repositories only. The objective on stdin is a JSON plan
// `{"steps": [...], "hang": false}`; each step is one of
//   {"op": "write", "path", "content"}            write a file (worktree-relative)
//   {"op": "commit", "message"}                   git add -A && git commit
//   {"op": "branch", "name"} / {"op": "tag", "name"}
//   {"op": "update_ref", "ref", "to"}             git update-ref <ref> <to>   (to: a revision such as HEAD)
//   {"op": "delete_ref", "ref"}                   git update-ref -d <ref>
//     (ref may be "@publish", the session's publish ref, or "@run_branch"; see refAlias)
//   {"op": "push", "remote", "refspec"}           git push <remote> <refspec> (a local bare repository in the tests)
//   {"op": "reset_hard", "to"}                    git reset --hard <to>
//   {"op": "checkout_new", "name"}                git checkout -b <name>
//   {"op": "tool_commit", "arguments"}            the injected `commit` tool (needs --tool-channel)
// Each step's outcome (op and exit status, or tool SHA/error code) is a `message` event. With "hang": true it then
// idles until killed (restart tests). It never leaves the worktree, reads no credential and uses no network.
//
// Session state (T5.2, FR-ADP-11; all optional, additive): `--state-dir NAME` makes the CLI keep its session state under
// `$HOME/NAME/`, as real CLIs keep sessions under the home directory. It appends one canary line to
// `sessions/<session id>.jsonl` (the "transcript"), appends `{"session_id", "prompt"}` (the stdin text it received) to
// `prompts.log`, and reports both absolute paths in a first `message` event `{"state": {...}}`. NAME is a relative
// path without `..`; `HOME` must be set (it is not passed unless the adapter's environment allowlist names it).
// `--resume-flag FLAG` (default `--resume`) names the flag that carries the session id to resume, and
// `--new-session-id ID` (default `fake-session-1`) the id of a session that is not resumed.
//
// `edit_files` (T9.7, FR-GIT-09) plays an agent WITHOUT a tool channel: the objective on stdin is a JSON plan
// `{"files": {"<rel path>": "<content>" | null}, "summary": "<text>" | null, "ok": true}`; it writes (or, for null,
// deletes) the files in its working directory and ends with a `result` event carrying the summary (none when null).
// `ok: false` ends as a task failure (exit 1). No Git command is run.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// A hanging scenario must outlive a controller that died (SIGKILL): ignore EPIPE instead of crashing on a late write.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const scenario = flagValue("--scenario") ?? "success";
// The resume flag's own name may be the value of `--resume-flag`, so look for it outside that pair.
const resumeFlag = flagValue("--resume-flag") ?? "--resume";
const resumeAt = argv.findIndex((a, i) => a === resumeFlag && argv[i - 1] !== "--resume-flag");
const sessionId = (resumeAt >= 0 ? argv[resumeAt + 1] : undefined) ?? flagValue("--new-session-id") ?? "fake-session-1";
const stateDirName = flagValue("--state-dir");
let stdinText; // read at most once: the state recorder and a plan scenario both need the prompt
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (argv.includes("--version")) {
  process.stdout.write("fake-cli 1.0.0\n");
} else if (argv.includes("--auth-status")) {
  if (scenario === "auth_missing") {
    process.stdout.write('{"authenticated":false}\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('{"authenticated":true}\n');
  }
} else if (argv.includes("--smoke")) {
  emit({ type: "result", ok: true, summary: "smoke" });
} else {
  const begin = () => emit({ type: "session", session_id: sessionId, model: "fake-model-1" });
  if (stateDirName !== undefined && (await recordState()) === false) process.exit(64);
  switch (scenario) {
    case "success":
      begin();
      emit({ type: "tool", tool: "read", name: "read_file", target: "README.md" });
      emit({ type: "message", text: "done" });
      emit({ type: "usage", input_tokens: 10, output_tokens: 5 });
      emit({ type: "future_event_kind" });
      emit({ type: "result", ok: true, summary: "completed" });
      break;
    case "fronted":
      // T4.6: a harness fronting another vendor reports the backing provider and model on the session event.
      emit({ type: "session", session_id: sessionId, model: "m-a", backing_provider: "backing-x" });
      emit({ type: "usage", input_tokens: 7, output_tokens: 2 });
      emit({ type: "result", ok: true, summary: "completed" });
      break;
    case "task_failure":
      begin();
      emit({ type: "error", category: "tool", message: "command failed" });
      emit({ type: "result", ok: false, summary: "task failed" });
      process.exitCode = 1;
      break;
    case "auth_missing":
      emit({ type: "error", category: "auth", message: "not logged in" });
      process.exitCode = 1;
      break;
    case "rate_limit":
      begin();
      emit({ type: "rate_limit", reset_at: "2026-01-01T00:00:00Z" });
      emit({ type: "error", category: "rate_limit", message: "slow down" });
      process.exitCode = 1;
      break;
    case "partial_mutation":
      begin();
      writeFileSync("partial.txt", "half-written\n"); // relative to cwd, on purpose
      emit({ type: "tool", tool: "edit", name: "write_file", target: "partial.txt" });
      emit({ type: "error", category: "tool", message: "crashed mid-edit" });
      process.exitCode = 2;
      break;
    case "malformed_output":
      begin();
      process.stdout.write("this is not json {\n");
      emit({ type: "result", ok: true, summary: "never trusted" });
      break;
    case "env_report":
      begin();
      emit({ type: "message", text: JSON.stringify({ env_names: Object.keys(process.env).sort() }) });
      emit({ type: "result", ok: true, summary: "env reported" });
      break;
    case "git_commit":
      begin();
      await gitCommitScenario();
      break;
    case "git_attempts":
      begin();
      await gitAttemptsScenario();
      break;
    case "edit_files":
      begin();
      await editFilesScenario();
      break;
    case "hang":
    case "hang_ignore_term":
      if (scenario === "hang_ignore_term") process.on("SIGTERM", () => {});
      begin();
      setInterval(() => {}, 1000);
      break;
    default:
      process.stderr.write(`unknown scenario: ${scenario}\n`);
      process.exitCode = 64;
  }
}

async function readStdin() {
  if (stdinText !== undefined) return stdinText;
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  stdinText = text;
  return text;
}

/** `--state-dir`: keep the canary transcript and the received prompt under `$HOME/<name>/` and report the paths. */
async function recordState() {
  const home = process.env.HOME;
  if (
    home === undefined ||
    !isAbsolute(home) ||
    stateDirName === "" ||
    isAbsolute(stateDirName) ||
    stateDirName.split(/[\\/]/).includes("..")
  ) {
    process.stderr.write("state directory needs an absolute HOME and a relative --state-dir without ..\n");
    return false;
  }
  const prompt = await readStdin();
  const root = join(home, stateDirName);
  const canaryPath = join(root, "sessions", `${sessionId}.jsonl`);
  const promptLog = join(root, "prompts.log");
  mkdirSync(dirname(canaryPath), { recursive: true });
  appendFileSync(canaryPath, `${JSON.stringify({ canary: "switchboard-canary", session_id: sessionId })}\n`);
  appendFileSync(promptLog, `${JSON.stringify({ session_id: sessionId, prompt })}\n`);
  emit({
    type: "message",
    text: JSON.stringify({ state: { session_id: sessionId, canary_path: canaryPath, prompt_log: promptLog } }),
  });
  return true;
}

async function editFilesScenario() {
  let plan;
  try {
    plan = JSON.parse(await readStdin());
  } catch {
    plan = undefined;
  }
  if (typeof plan !== "object" || plan === null) plan = {};
  for (const [rel, content] of Object.entries(plan.files ?? {})) {
    if (content === null) {
      rmSync(rel, { force: true }); // relative to cwd, the run worktree
      emit({ type: "tool", tool: "edit", name: "delete_file", target: rel });
      continue;
    }
    mkdirSync(dirname(rel), { recursive: true });
    writeFileSync(rel, content); // relative to cwd, the run worktree
    emit({ type: "tool", tool: "edit", name: "write_file", target: rel });
  }
  const ok = plan.ok !== false;
  const summary = typeof plan.summary === "string" ? plan.summary : undefined;
  if (!ok) emit({ type: "error", category: "tool", message: "task failed" });
  emit({ type: "result", ok, ...(summary !== undefined ? { summary } : {}) });
  if (!ok) process.exitCode = 1;
}

async function gitCommitScenario() {
  const raw = flagValue("--tool-channel");
  const token = process.env.SWITCHBOARD_TOOL_TOKEN;
  if (raw === undefined || token === undefined) {
    emit({ type: "error", category: "tool", message: "no tool channel" });
    emit({ type: "result", ok: false, summary: "no tool channel" });
    process.exitCode = 1;
    return;
  }
  let plan;
  try {
    plan = JSON.parse(await readStdin());
  } catch {
    plan = undefined;
  }
  if (typeof plan !== "object" || plan === null || !Array.isArray(plan.calls)) {
    plan = {
      files: { "feature.txt": "a new feature\n" },
      calls: [
        {
          name: "commit",
          arguments: {
            message: "Add the feature\n\nCo-authored-by: Fake Agent <agent@example.test>",
            paths: ["feature.txt"],
          },
        },
      ],
    };
  }
  // T9.10 environment inspection: report the variable NAMES this provider process received (never values).
  if (plan.report_env === true) {
    emit({ type: "message", text: JSON.stringify({ env_names: Object.keys(process.env).sort() }) });
  }
  for (const [rel, content] of Object.entries(plan.files ?? {})) {
    mkdirSync(dirname(rel), { recursive: true });
    writeFileSync(rel, content); // relative to cwd, the run worktree
  }
  const client = await connectTools(raw, token);
  const listed = await client.listTools();
  emit({ type: "message", text: JSON.stringify({ tools: listed.tools.map((t) => t.name) }) });
  for (const call of plan.calls) await callTool(client, call.name, call.arguments);
  await client.close();
  emit({ type: "result", ok: true, summary: "tool calls made" });
}

async function connectTools(raw, token) {
  const { command } = JSON.parse(raw);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: command[0],
    args: command.slice(1),
    env: { PATH: process.env.PATH ?? "", SWITCHBOARD_TOOL_TOKEN: token },
    stderr: "ignore",
  });
  const client = new Client({ name: "fake-agent", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args) {
  emit({ type: "tool", tool: "other", name: String(name) });
  const res = await client.callTool({ name, arguments: args ?? {} });
  let body = {};
  try {
    body = JSON.parse(res.content?.[0]?.text ?? "{}");
  } catch {
    body = {};
  }
  const outcome = res.isError
    ? { error: body.code ?? "unknown" }
    : name === "push"
      ? { pushed: body.pushed, ref: body.ref, head_sha: body.head_sha }
      : { sha: body.sha, files_changed: body.files_changed };
  emit({ type: "message", text: JSON.stringify({ call: name, ...outcome }) });
}

/** Plain Git, as an agent with a shell would run it: no hooks bypass, no global options, local repositories only. */
function agentGit(args) {
  const full = [
    "-c",
    "user.name=Fake Agent",
    "-c",
    "user.email=agent@example.test",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ];
  try {
    execFileSync("git", full, { stdio: ["ignore", "ignore", "ignore"] });
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : -1;
  }
}

/**
 * `@run_branch` is the branch checked out in the worktree; `@publish` is the meta-session's publish ref under the
 * default prefix, derived from that branch name (`switchboard/<sess>/<run>`), so a plan can name refs before the test
 * knows the session id.
 */
function refAlias(ref) {
  if (ref !== "@run_branch" && ref !== "@publish") return ref;
  let branch = "";
  try {
    branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return ref;
  }
  if (ref === "@run_branch") return `refs/heads/${branch}`;
  return `refs/heads/switchboard/pub/${branch.split("/")[1] ?? ""}`;
}

async function gitAttemptsScenario() {
  let plan;
  try {
    plan = JSON.parse(await readStdin());
  } catch {
    plan = undefined;
  }
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const raw = flagValue("--tool-channel");
  const token = process.env.SWITCHBOARD_TOOL_TOKEN;
  let client;
  for (const step of steps) {
    let rc;
    switch (step.op) {
      case "write":
        mkdirSync(dirname(step.path), { recursive: true });
        writeFileSync(step.path, step.content); // relative to cwd, the run worktree
        rc = 0;
        break;
      case "commit":
        rc = agentGit(["add", "-A"]) || agentGit(["commit", "-q", "-m", step.message]);
        break;
      case "branch":
        rc = agentGit(["branch", step.name]);
        break;
      case "tag":
        rc = agentGit(["tag", step.name]);
        break;
      case "update_ref":
        rc = agentGit(["update-ref", refAlias(step.ref), step.to]);
        break;
      case "delete_ref":
        rc = agentGit(["update-ref", "-d", refAlias(step.ref)]);
        break;
      case "push":
        rc = agentGit(["push", "-q", step.remote, step.refspec]);
        break;
      case "reset_hard":
        rc = agentGit(["reset", "-q", "--hard", step.to]);
        break;
      case "checkout_new":
        rc = agentGit(["checkout", "-q", "-b", step.name]);
        break;
      case "tool_commit":
        if (raw === undefined || token === undefined) {
          rc = -1;
          break;
        }
        client ??= await connectTools(raw, token);
        await callTool(client, "commit", step.arguments);
        continue;
      default:
        rc = -2;
    }
    emit({ type: "message", text: JSON.stringify({ op: step.op, rc }) });
  }
  await client?.close();
  if (plan?.hang === true) {
    emit({ type: "message", text: JSON.stringify({ steps_done: steps.length }) });
    setInterval(() => {}, 1000);
    return;
  }
  emit({ type: "result", ok: true, summary: "git attempts made" });
}
