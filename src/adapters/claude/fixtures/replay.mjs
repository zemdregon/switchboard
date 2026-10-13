#!/usr/bin/env node
// Replays a recorded (hand-written, SYNTHETIC) Claude Code stream-json fixture for adapter tests (T2.2, FR-ADP-11).
// Not a provider: it never contacts a model, the network or any credential store.
//
// Usage: replay.mjs --fixture FILE.jsonl [--exit-code N] [--write REL_PATH] [--hang] [--ignore-term]
//                   [--mcp-commit RECORD.json] -- <claude argv>
// Lines of FILE.jsonl are written to stdout verbatim, except lines whose JSON has a "_fixture" key (provenance notes),
// which are skipped. "{{SESSION_ID}}" is replaced by the value of --resume in the claude argv, or by a default id.
// The claude argv is checked for the documented headless shape (-p, --output-format stream-json) and the prompt must
// arrive on stdin; otherwise the replay exits 64/65 so a wrong compile cannot pass silently.
//
// --mcp-commit (T9.4b, ADR-0029) stands in for what Claude Code is ASSUMED to do with `--mcp-config <file>` (unverified,
// live check): it reads the one definition file named in the claude argv, records evidence (argv, file text, file and
// directory modes, whether the token variable is in its environment; never the token) to RECORD.json, starts the one
// stdio server with `${VAR}` references in its `env` expanded from this process's environment, lists its tools and
// calls `commit` for a file it writes into the cwd. The fixture is replayed afterwards as usual.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A hanging scenario must outlive a controller that died (SIGKILL): ignore EPIPE instead of crashing on a late write.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const all = process.argv.slice(2);
const sep = all.indexOf("--");
const own = sep >= 0 ? all.slice(0, sep) : all;
const claude = sep >= 0 ? all.slice(sep + 1) : [];
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const fixture = opt(own, "--fixture");
if (!fixture) {
  process.stderr.write("replay: --fixture is required\n");
  process.exit(64);
}
const outputFormat = opt(claude, "--output-format");
if (!claude.includes("-p") || outputFormat !== "stream-json") {
  process.stderr.write("replay: expected claude -p --output-format stream-json\n");
  process.exit(64);
}
const sessionId = opt(claude, "--resume") ?? "00000000-0000-4000-8000-000000000001";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  if (prompt.trim() === "") {
    process.stderr.write("replay: no prompt on stdin\n");
    process.exit(65);
  }
  const write = opt(own, "--write");
  if (write) writeFileSync(write, "synthetic edit from replay fixture\n"); // relative to cwd, on purpose
  const record = opt(own, "--mcp-commit");
  if (record) await mcpCommit(record);
  for (const line of readFileSync(fixture, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      if (Object.hasOwn(JSON.parse(line), "_fixture")) continue;
    } catch {
      // malformed lines are part of some fixtures and are replayed verbatim
    }
    process.stdout.write(`${line.replaceAll("{{SESSION_ID}}", sessionId)}\n`);
  }
  if (own.includes("--hang")) {
    if (own.includes("--ignore-term")) process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = Number(opt(own, "--exit-code") ?? 0);
});

async function mcpCommit(recordPath) {
  const out = {
    argv: claude,
    tokenInEnv: typeof process.env.SWITCHBOARD_TOOL_TOKEN === "string",
    // Names only, never values: the stdio server inherits this whole environment (live check, PR #41).
    envKeys: Object.keys(process.env).sort(),
    calls: [],
  };
  try {
    const file = opt(claude, "--mcp-config");
    out.config = readFileSync(file, "utf8");
    out.mode = statSync(file).mode & 0o777;
    out.dirMode = statSync(dirname(file)).mode & 0o777;
    const servers = Object.entries(JSON.parse(out.config).mcpServers ?? {});
    out.servers = servers.map(([name]) => name);
    if (servers.length !== 1) throw new Error("expected exactly one server");
    const [, def] = servers[0];
    const env = { PATH: process.env.PATH ?? "" };
    for (const [k, v] of Object.entries(def.env ?? {})) {
      const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(String(v));
      env[k] = m ? (process.env[m[1]] ?? "") : String(v);
    }
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({ command: def.command, args: def.args, env, stderr: "ignore" });
    const client = new Client({ name: "claude-replay", version: "1.0.0" });
    await client.connect(transport);
    out.tools = (await client.listTools()).tools.map((t) => t.name);
    writeFileSync("channel.txt", "committed through the claude channel\n"); // relative to cwd, the worktree
    const res = await client.callTool({
      name: "commit",
      arguments: { message: "Add channel.txt", paths: ["channel.txt"] },
    });
    out.calls.push({ name: "commit", isError: res.isError === true, text: res.content?.[0]?.text ?? "" });
    await client.close();
  } catch (err) {
    out.error = String(err?.message ?? err);
  }
  writeFileSync(recordPath, JSON.stringify(out));
}
