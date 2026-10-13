#!/usr/bin/env node
// Scripted fake ACP agent for tests (T4.8, ADR-0036 "Conformance plan"). Beside the M1 fake CLI (`cli.mjs`). Needs no
// real provider, network or credentials, and implements no real agent: it plays a fixture.
//
// Usage: acp-agent.mjs --fixture <file.json> [--record <file.jsonl>]
//
// The fixture is `{"steps": [...], "ignoreTerm": false}`. Steps run in order:
//   {"recv": "<method>", "reply": {"result": ...} | {"error": ...}}
//        wait for the next client message with that method (requests, notifications); reply with the given body
//        using the request's id when `reply` is present. The id is remembered under the method name for `reply_to`.
//   {"reply_to": "<method>", "result": ...} | {"reply_to": "<method>", "error": ...}
//        answer a request received earlier (e.g. the pending `session/prompt`).
//   {"recv_response": <id>}       wait for the client's response to an agent request with this id.
//   {"send": {...}}               write one JSON-RPC message (`"jsonrpc": "2.0"` is added when absent).
//   {"raw": "<text>"}             write raw text exactly as given (no newline added).
//   {"rawBase64": "<b64>"}        write raw bytes (for invalid UTF-8).
//   {"sleep": <ms>}
//   {"exit": <code>}              exit now.
//   {"hang": true}                stop scripting and idle until killed (ignores stdin end).
// After the last step the agent idles until its stdin ends, then exits 0 (as an agent does when the client closes it).
// With `"ignoreTerm": true` it ignores SIGTERM, so only the group SIGKILL ends it.
//
// Every message received from the client is appended to the record file as one JSON line `{"recv": <message>}`, and
// the first line is `{"env": [<names of the environment variables it received>]}` (names only, never values).
import { appendFileSync, readFileSync } from "node:fs";

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fixturePath = flagValue("--fixture");
const recordPath = flagValue("--record");
const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : { steps: [] };
const record = (obj) => {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(obj)}\n`);
};
record({ env: Object.keys(process.env).sort() });
if (fixture.ignoreTerm === true) process.on("SIGTERM", () => {});
process.stderr.write("fake-acp-agent: started (stderr is a log, never protocol)\n");

const inbox = [];
let waiter;
let stdinEnded = false;
let buffer = "";
const requestIds = new Map();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = { unparseable: line };
    }
    record({ recv: msg });
    inbox.push(msg);
  }
  waiter?.();
});
process.stdin.on("end", () => {
  stdinEnded = true;
  waiter?.();
});

const write = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...obj })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000);

/** Waits for the first inbox message matching `pred` and removes it; undefined when stdin ended first. */
async function take(pred) {
  for (;;) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (stdinEnded) return undefined;
    await new Promise((r) => {
      waiter = r;
    });
    waiter = undefined;
  }
}

async function main() {
  for (const step of fixture.steps ?? []) {
    if (step.recv !== undefined) {
      const msg = await take((m) => m.method === step.recv);
      if (msg === undefined) break;
      if (msg.id !== undefined) requestIds.set(step.recv, msg.id);
      if (step.reply !== undefined && msg.id !== undefined) write({ id: msg.id, ...step.reply });
    } else if (step.reply_to !== undefined) {
      const id = requestIds.get(step.reply_to);
      const { reply_to: _ignored, ...body } = step;
      write({ id, ...body });
    } else if (step.recv_response !== undefined) {
      const msg = await take((m) => m.method === undefined && m.id === step.recv_response);
      if (msg === undefined) break;
    } else if (step.send !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...step.send })}\n`);
    } else if (step.raw !== undefined) {
      process.stdout.write(step.raw);
    } else if (step.rawBase64 !== undefined) {
      process.stdout.write(Buffer.from(step.rawBase64, "base64"));
    } else if (step.sleep !== undefined) {
      await sleep(step.sleep);
    } else if (step.exit !== undefined) {
      process.exit(step.exit);
    } else if (step.hang === true) {
      return; // keepAlive holds the process until it is killed
    }
  }
  while (!stdinEnded) {
    await new Promise((r) => {
      waiter = r;
    });
    waiter = undefined;
  }
  clearInterval(keepAlive);
  process.exit(0);
}

void main();
