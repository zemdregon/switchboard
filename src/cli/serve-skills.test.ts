/**
 * T16.9 (FR-SKL-08, LLD §19.9): `switchboard serve` wires the skill store into the MCP server only when
 * `skills.enabled`. Each test spawns the real `serve` over stdio (the test-only fake adapter, no provider CLI on PATH)
 * and seeds the store through the operator CLI first, while no daemon holds the data-directory lock.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { source } from "../skills/fixtures/sources.js";
import type { CliIo } from "./io.js";
import { main } from "./main.js";
import { TEST_FAKE_ADAPTER_ENV, TEST_FAKE_ADAPTER_VALUE } from "./serve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "bin.ts");
const TS_REGISTER = path.join(HERE, "..", "reconcile", "fixtures", "ts-register.mjs");
const NODE_ARGS = ["--experimental-transform-types", "--no-warnings", "--import", TS_REGISTER, BIN];
const SKILL_TOOLS = ["list_skills", "get_skill"];

let root: string;
let dataDir: string;
let configPath: string;
const clients: Client[] = [];

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(root, "repos")],
      mcp_clients: [
        { id: "orch", max_trust_profile: "edit-untrusted" },
        { id: "cons", max_trust_profile: "edit-untrusted", tool_profile: "console" },
      ],
      ...extra,
    }),
  );
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-serve-skills-")));
  dataDir = path.join(root, "data");
  for (const d of ["repos", "home", "bin", "operator"]) mkdirSync(path.join(root, d));
  // PATH holds git only, so no provider CLI on this host is ever probed (AGENTS.md: tests never call a provider).
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(root, "bin", "git"));
  configPath = path.join(root, "config.json");
  writeConfig();
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

/** Run the operator CLI in process (before any serve starts). */
async function cli(args: string[]): Promise<void> {
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: () => undefined },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
  };
  const code = await main([...args, "--config", configPath], io);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}: ${err.join("")}`);
}

async function addSkill(name: string, body: string, approve: boolean): Promise<void> {
  const file = path.join(root, "operator", `${name}.md`);
  writeFileSync(file, source(body, { name }));
  await cli(["skills", "add", name, "--file", file]);
  if (approve) await cli(["skills", "approve", `${name}@1`]);
}

/** Start `serve --client <id>` and connect an SDK stdio client to it. */
async function connect(clientId: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_ARGS, "serve", "--client", clientId, "--config", configPath],
    env: {
      PATH: path.join(root, "bin"),
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "home", ".config"),
      XDG_DATA_HOME: path.join(root, "home", ".local", "share"),
      [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "serve-skills-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** `tools/list` from a fresh serve, which is then closed so the next one can take the data-directory lock. */
async function listTools(clientId: string) {
  const c = await connect(clientId);
  const { tools } = await c.listTools();
  await c.close();
  return tools;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) };
}

describe("serve wires the skill store (T16.9; FR-SKL-08, LLD §19.9)", () => {
  it("disabled (no skills key, or enabled: false) offers the same 17 tools; enabled adds only the skill tools for an orchestrator", async () => {
    const absent = await listTools("orch");
    expect(absent).toHaveLength(17);
    for (const t of SKILL_TOOLS) expect(absent.map((x) => x.name)).not.toContain(t);

    writeConfig({ skills: { enabled: false } });
    expect(JSON.stringify(await listTools("orch"))).toBe(JSON.stringify(absent));

    writeConfig({ skills: { enabled: true } });
    const enabled = await listTools("orch");
    expect(enabled.map((x) => x.name)).toEqual(expect.arrayContaining(SKILL_TOOLS));
    expect(JSON.stringify(enabled.filter((x) => !SKILL_TOOLS.includes(x.name)))).toBe(JSON.stringify(absent));

    const consoleNames = (await listTools("cons")).map((x) => x.name);
    for (const t of SKILL_TOOLS) expect(consoleNames).not.toContain(t);
  }, 60_000);

  it("enabled: list_skills reads the store under the data directory; a draft get_skill misses like an unknown name", async () => {
    await addSkill("security-review", "check inputs\n", true);
    await addSkill("draft-only", "not yet\n", false);
    writeConfig({ skills: { enabled: true } });
    const c = await connect("orch");

    const listed = await call(c, "list_skills", {});
    expect(listed.isError).toBe(false);
    expect(listed.body.skills.map((s: { name: string }) => s.name)).toEqual(["security-review"]);

    const got = await call(c, "get_skill", { name: "security-review" });
    expect(got.isError).toBe(false);
    expect(JSON.stringify(got.body)).toContain("check inputs");

    const draft = await call(c, "get_skill", { name: "draft-only" });
    const unknown = await call(c, "get_skill", { name: "no-such-skill" });
    expect(draft.isError).toBe(true);
    expect(draft.body.error).toMatchObject({ code: "INVALID_REQUEST", message: "unknown skill" });
    expect(draft.body).toEqual(unknown.body);
  }, 60_000);
});
