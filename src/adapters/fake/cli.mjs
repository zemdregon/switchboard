#!/usr/bin/env node
// Fake provider CLI for tests (T1.7, TDD §3.6). Needs no real provider, network or credentials.
// Usage: cli.mjs [--scenario NAME] [--resume SESSION_ID] [--version | --auth-status | --smoke]
// Scenarios: success, task_failure, auth_missing, rate_limit, partial_mutation, malformed_output, hang,
// hang_ignore_term. The prompt, if any, arrives on stdin and is ignored.
import { writeFileSync } from "node:fs";

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
