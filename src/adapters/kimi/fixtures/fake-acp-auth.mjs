#!/usr/bin/env node
// SYNTHETIC stand-in for `kimi acp` in the auth probe test (T4.64): reads JSON-RPC lines from stdin and answers
// `initialize` and `session/new` in the shapes of the 2026-10-15 live check ([LIVE] 8 to 10). No `kimi` is run.
// Usage: node fake-acp-auth.mjs --scenario=<logged-in|logged-out|silent|exit-on-eof> acp
// - exit-on-eof: answers `initialize` at once and `session/new` only after a delay, and exits 0 as soon as stdin ends
//   (the race seen on CLI 2.1.1 on 2026-10-17: `session/new missing, exit 0` when stdin was closed after writing).
// - silent: answers nothing, prints one log line to stderr and exits 0 on its own after a short delay.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = (process.argv.find((a) => a.startsWith("--scenario=")) ?? "").slice("--scenario=".length);
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
if (process.argv.at(-1) !== "acp") process.exit(2);
if (scenario === "silent") {
  process.stderr.write(
    `{"level":"error","msg":"acp: auth readiness probe failed","file":"${process.env.HOME ?? "/home/x"}/.kimi/log","token":"sk-abcdefghijklmnopqrstuvwxyz0123"}\n`,
  );
  setTimeout(() => process.exit(0), 200);
}
const rl = createInterface({ input: process.stdin });
if (scenario === "exit-on-eof") rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  if (scenario === "silent") return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "2.1.1" } } });
  } else if (msg.method === "session/new") {
    // The probe must open the session in its own working directory (real paths: macOS tmpdir is a symlink).
    const cwd = typeof msg.params?.cwd === "string" ? realpathSync(msg.params.cwd) : undefined;
    const reply = () => {
      if (cwd !== realpathSync(process.cwd())) send({ id: msg.id, error: { code: -32602, message: "cwd mismatch" } });
      else if (scenario === "logged-out")
        send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
      else send({ id: msg.id, result: { sessionId: "session_00000000-0000-4000-8000-000000000000" } });
    };
    if (scenario === "exit-on-eof") setTimeout(reply, 150);
    else reply();
  }
});
