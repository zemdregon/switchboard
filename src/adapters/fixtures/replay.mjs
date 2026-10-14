#!/usr/bin/env node
// The one shared recorded-fixture replay helper (T4.3, FR-ADP-11, TDD §3.6). It stands in for a provider binary in
// tests: it never contacts a model, the network or any credential store, and reads no file other than the fixture
// (and, for --mcp-commit, the one MCP definition file named in the provider argv).
//
// Usage: replay.mjs --provider ID --fixture FILE.jsonl [--exit-code N] [--write REL_PATH] [--hang] [--ignore-term]
//                   [--mcp-commit RECORD.json] -- <provider argv>
// Lines of FILE.jsonl are written to stdout verbatim, except lines whose JSON has a "_fixture" key (provenance notes
// and, for Codex, run metadata), which are skipped. Malformed lines are replayed verbatim on purpose. The prompt must
// arrive on stdin, or in argv for a dialect that defines `prompt`; otherwise the replay exits 65. A provider argv of the
// wrong shape exits 64, so a wrong compile cannot pass silently.
//
// A provider is one file in ./replay-dialects/<id>.mjs (default export, see claude.mjs): how it checks its argv, what a
// session id placeholder in the fixture means and which probe invocations (`--version`, help) the replay answers.
// Adding a provider adds a file there; this helper is not edited. Probe texts are SYNTHETIC test data, not claims
// about a real CLI.
//
// Run metadata comes from the flags above or, when a flag is absent, from an object-valued `_fixture` on the first
// line: { synthetic: true, exit, write: { path, content }, hang: true | "ignore_term", requireResume }.
//
// --mcp-commit (T9.4b, ADR-0029; Claude only) stands in for what Claude Code is ASSUMED to do with `--mcp-config <file>`
// (unverified, live check): it reads the one definition file named in the argv, records evidence (argv, file text,
// file and directory modes, whether the token variable is in its environment; never the token) to RECORD.json, starts
// the one stdio server with `${VAR}` references in its `env` expanded from this process's environment, lists its tools
// and calls `commit` for a file it writes into the cwd. The fixture is replayed afterwards as usual.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A hanging scenario must outlive a controller that died (SIGKILL): ignore EPIPE instead of crashing on a late write.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};
const fail = (msg, code) => {
  process.stderr.write(`replay: ${msg}\n`);
  process.exit(code);
};

const all = process.argv.slice(2);
const sep = all.indexOf("--");
const own = sep >= 0 ? all.slice(0, sep) : all;
const argv = sep >= 0 ? all.slice(sep + 1) : [];

const providerId = opt(own, "--provider");
const DIALECT_DIR = new URL("./replay-dialects/", import.meta.url);
const known = readdirSync(DIALECT_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.slice(0, -".mjs".length));
if (providerId === undefined || !known.includes(providerId)) {
  fail(`--provider must be one of ${known.sort().join(", ")}`, 64);
}
/** @type {import("./replay-dialects/claude.mjs").Dialect} */
const dialect = (await import(new URL(`${providerId}.mjs`, DIALECT_DIR).href)).default;
const fixture = opt(own, "--fixture");
if (!fixture) fail("--fixture is required", 64);

const probeOut = dialect.probe(argv);
if (probeOut !== undefined) {
  process.stdout.write(probeOut);
  process.exit(0);
}
dialect.check(argv, fail);

const fixtureLines = readFileSync(fixture, "utf8").split("\n");
let meta = {};
try {
  const first = JSON.parse(fixtureLines[0] ?? "");
  if (typeof first?._fixture === "object" && first._fixture !== null) meta = first._fixture;
} catch {
  // a fixture without a metadata line is fine unless the dialect requires one
}
if (dialect.requireSynthetic && meta.synthetic !== true) fail("fixture metadata missing", 64);
const session = dialect.session(argv);
if (meta.requireResume && session.value === undefined) fail("resume fixture invoked without `resume <id>`", 64);

// A dialect whose CLI takes the prompt as an argv word (OpenCode) names it through `prompt`; stdin is then not read.
const argvPrompt = dialect.prompt?.(argv);
if (argvPrompt !== undefined) {
  await replay(argvPrompt, "argv");
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => replay(prompt, "stdin"));
}

async function replay(prompt, from) {
  if (prompt.trim() === "") fail(`no prompt on ${from}`, 65);
  const write = opt(own, "--write");
  if (write)
    writeFileSync(write, "synthetic edit from replay fixture\n"); // relative to cwd, on purpose
  else if (meta.write) writeFileSync(meta.write.path, meta.write.content); // relative to cwd (the run worktree)
  const record = opt(own, "--mcp-commit");
  if (record) await mcpCommit(record);
  for (const line of fixtureLines) {
    if (line.trim() === "") continue;
    try {
      if (Object.hasOwn(JSON.parse(line), "_fixture")) continue;
    } catch {
      // malformed lines are part of some fixtures and are replayed verbatim
    }
    process.stdout.write(`${session.value === undefined ? line : line.replaceAll(session.token, session.value)}\n`);
  }
  const hang = own.includes("--hang") ? (own.includes("--ignore-term") ? "ignore_term" : true) : meta.hang;
  if (hang) {
    if (hang === "ignore_term") process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = Number(opt(own, "--exit-code") ?? meta.exit ?? 0);
}

async function mcpCommit(recordPath) {
  const out = {
    argv,
    tokenInEnv: typeof process.env.SWITCHBOARD_TOOL_TOKEN === "string",
    // Names only, never values: the stdio server inherits this whole environment (live check, PR #41).
    envKeys: Object.keys(process.env).sort(),
    calls: [],
  };
  try {
    const file = opt(argv, "--mcp-config");
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
    const client = new Client({ name: "replay", version: "1.0.0" });
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
