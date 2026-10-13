#!/usr/bin/env node
// Fake provider CLI for tests (T1.7, TDD §3.6). Needs no real provider, network or credentials.
// Usage: cli.mjs [--scenario NAME] [--resume SESSION_ID] [--version | --auth-status | --smoke]
// Scenarios: success, task_failure, auth_missing, rate_limit, partial_mutation, malformed_output, hang,
// hang_ignore_term, env_report, git_commit. The prompt, if any, arrives on stdin and is ignored except by git_commit.
// `env_report` lists the NAMES (never the values) of the environment variables the child received, for the
// environment-allowlist test (T3.8, FR-EXE-07).
//
// `git_commit` (T9.4, FR-GIT-02) plays an agent that uses the injected tool channel: `--tool-channel <json>` names the
// shim command (`{"command": [...]}`) and the token arrives in SWITCHBOARD_TOOL_TOKEN. The objective on stdin may be a
// JSON plan `{"files": {"<rel path>": "<content>"}, "calls": [{"name": "commit", "arguments": {...}}]}`; otherwise a
// default plan writes feature.txt and commits it with a message that carries an attribution trailer. Each call's
// outcome is reported as a `message` event (SHA or error code only; never the token). Tool errors do not fail the run.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A hanging scenario must outlive a controller that died (SIGKILL): ignore EPIPE instead of crashing on a late write.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const scenario = flagValue("--scenario") ?? "success";
const sessionId = flagValue("--resume") ?? "fake-session-1";
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
  switch (scenario) {
    case "success":
      begin();
      emit({ type: "tool", tool: "read", name: "read_file", target: "README.md" });
      emit({ type: "message", text: "done" });
      emit({ type: "usage", input_tokens: 10, output_tokens: 5 });
      emit({ type: "future_event_kind" });
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
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
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
  for (const [rel, content] of Object.entries(plan.files ?? {})) {
    mkdirSync(dirname(rel), { recursive: true });
    writeFileSync(rel, content); // relative to cwd, the run worktree
  }
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
  const listed = await client.listTools();
  emit({ type: "message", text: JSON.stringify({ tools: listed.tools.map((t) => t.name) }) });
  for (const call of plan.calls) {
    emit({ type: "tool", tool: "other", name: String(call.name) });
    const res = await client.callTool({ name: call.name, arguments: call.arguments ?? {} });
    let body = {};
    try {
      body = JSON.parse(res.content?.[0]?.text ?? "{}");
    } catch {
      body = {};
    }
    const outcome = res.isError
      ? { error: body.code ?? "unknown" }
      : { sha: body.sha, files_changed: body.files_changed };
    emit({ type: "message", text: JSON.stringify({ call: call.name, ...outcome }) });
  }
  await client.close();
  emit({ type: "result", ok: true, summary: "tool calls made" });
}
