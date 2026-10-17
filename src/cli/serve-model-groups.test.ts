/**
 * T7.14 (FR-RTE-10, FR-RTE-11, LLD §17.7): `switchboard serve` passes the configured `model_groups` to the MCP server
 * and to queue admission, so a group in config.json is accepted on `delegate_task` and `enqueue_work`. Each test spawns
 * the real `serve` over stdio (the test-only fake adapter, no provider CLI on PATH).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_FAKE_ADAPTER_ENV, TEST_FAKE_ADAPTER_VALUE } from "./serve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "bin.ts");
const TS_REGISTER = path.join(HERE, "..", "reconcile", "fixtures", "ts-register.mjs");
const NODE_ARGS = ["--experimental-transform-types", "--no-warnings", "--import", TS_REGISTER, BIN];
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

let root: string;
let repo: string;
let configPath: string;
const clients: Client[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-serve-model-groups-")));
  for (const d of ["repos", "home", "bin"]) mkdirSync(path.join(root, d));
  // PATH holds git only, so no provider CLI on this host is ever probed (AGENTS.md: tests never call a provider).
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(root, "bin", "git"));
  repo = path.join(root, "repos", "web");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: path.join(root, "data"),
      allowed_roots: [path.join(root, "repos")],
      mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted", projects: ["web"] }],
      projects: [
        {
          id: "web",
          name: "Web",
          contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main", push: { policy: "none" } }],
        },
      ],
      // Members use config provider ids; `provider_preference` names adapter ids (`claude-code` is adapter `claude`).
      model_groups: {
        cheap: {
          members: [
            { provider: "claude-code", model: "haiku-x" },
            { provider: "opencode", model: "oc-flash" },
          ],
        },
      },
    }),
  );
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

/** Start `serve --client orch` and connect an SDK stdio client to it. */
async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_ARGS, "serve", "--client", "orch", "--config", configPath],
    env: {
      PATH: path.join(root, "bin"),
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "home", ".config"),
      XDG_DATA_HOME: path.join(root, "home", ".local", "share"),
      [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "serve-model-groups-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) };
}

const TASK = { objective: "Fix bug", trust_profile: "edit-untrusted" };

describe("serve wires configured model_groups (T7.14; FR-RTE-11, LLD §17.7)", () => {
  it("delegate_task accepts a configured group, narrowed by an adapter id; a group narrowed to no member is refused", async () => {
    const c = await connect();

    const plain = await call(c, "delegate_task", { ...TASK, workspace_path: repo, routing: { model_group: "cheap" } });
    expect(plain.isError, JSON.stringify(plain.body)).toBe(false);
    expect(plain.body.run_id).toMatch(/^run_/);

    const claude = await call(c, "delegate_task", {
      ...TASK,
      workspace_path: repo,
      routing: { model_group: "cheap", provider_preference: "claude" },
    });
    expect(JSON.stringify(claude.body)).not.toContain("model_group");
    expect(claude.isError, JSON.stringify(claude.body)).toBe(false);

    const codex = await call(c, "delegate_task", {
      ...TASK,
      workspace_path: repo,
      routing: { model_group: "cheap", provider_preference: "codex" },
    });
    expect(codex.isError).toBe(true);
    expect(codex.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "model_group cheap has no members for provider codex",
    });

    const unknown = await call(c, "delegate_task", { ...TASK, workspace_path: repo, routing: { model_group: "nope" } });
    expect(unknown.body.error).toMatchObject({ code: "INVALID_REQUEST", message: "unknown model_group nope" });
  }, 60_000);

  it("enqueue_work accepts a configured group and queue admission admits it", async () => {
    const c = await connect();

    const queued = await call(c, "enqueue_work", {
      project_id: "web",
      request: { ...TASK, routing: { model_group: "cheap", provider_preference: "claude" } },
    });
    expect(queued.isError, JSON.stringify(queued.body)).toBe(false);
    const id = queued.body.work_item_id as string;

    const narrowed = await call(c, "enqueue_work", {
      project_id: "web",
      request: { ...TASK, routing: { model_group: "cheap", provider_preference: "codex" } },
    });
    expect(narrowed.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "model_group cheap has no members for provider codex",
    });

    // The serve scheduler ticks every second; admission re-checks the group against the same table.
    const deadline = Date.now() + 30_000;
    // biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
    let item: any;
    while (Date.now() < deadline) {
      item = (await call(c, "list_work", {})).body.items.find((i: { work_item_id: string }) => i.work_item_id === id);
      if (item.admitted_run_id !== null || item.terminal_at !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(item.admitted_run_id, JSON.stringify(item)).toMatch(/^run_/);
  }, 60_000);
});
