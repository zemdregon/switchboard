/**
 * T7.14 (FR-RTE-10, FR-RTE-11, LLD §17.7): `switchboard serve` passes the configured `model_groups` to the MCP server
 * and to queue admission, so a group in config.json is accepted on `delegate_task` and `enqueue_work`. Each test spawns
 * the real `serve` over stdio (the test-only fake adapter, no provider CLI on PATH). With no member's CLI installed, an
 * accepted group request goes on to member-level eligibility (T7.15) and is refused there as ELIGIBILITY_NONE, naming
 * each configured member it considered; an unknown group would instead be INVALID_REQUEST before eligibility.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const considered = (body: { error: { code: string; details?: { eligibility?: { provider: string }[] } } }) => ({
      code: body.error.code,
      members: (body.error.details?.eligibility ?? []).map((e) => e.provider),
    });

    const plain = await call(c, "delegate_task", { ...TASK, workspace_path: repo, routing: { model_group: "cheap" } });
    expect(considered(plain.body), JSON.stringify(plain.body)).toEqual({
      code: "ELIGIBILITY_NONE",
      members: ["claude/haiku-x", "opencode/oc-flash"],
    });

    // `claude` (adapter id) narrows to the `claude-code` (config id) member.
    const claude = await call(c, "delegate_task", {
      ...TASK,
      workspace_path: repo,
      routing: { model_group: "cheap", provider_preference: "claude" },
    });
    expect(considered(claude.body), JSON.stringify(claude.body)).toEqual({
      code: "ELIGIBILITY_NONE",
      members: ["claude/haiku-x"],
    });

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

  it("enqueue_work accepts a configured group and queue admission resolves it from the same table", async () => {
    const c = await connect();

    const queued = await call(c, "enqueue_work", {
      project_id: "web",
      request: { ...TASK, routing: { model_group: "cheap", provider_preference: "claude" } },
    });
    expect(queued.isError, JSON.stringify(queued.body)).toBe(false);
    expect(queued.body.state).toBe("READY");
    const id = queued.body.work_item_id as string;

    const narrowed = await call(c, "enqueue_work", {
      project_id: "web",
      request: { ...TASK, routing: { model_group: "cheap", provider_preference: "codex" } },
    });
    expect(narrowed.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "model_group cheap has no members for provider codex",
    });

    // The serve scheduler ticks every second. Admission without the group table would record INVALID_REQUEST
    // (unknown model_group); with it, the request reaches member eligibility and no member's CLI is installed.
    const deadline = Date.now() + 30_000;
    // biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
    let item: any;
    while (Date.now() < deadline) {
      item = (await call(c, "list_work", {})).body.items.find((i: { work_item_id: string }) => i.work_item_id === id);
      if (item.admitted_run_id !== null || item.terminal_at !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(item, JSON.stringify(item)).toMatchObject({ admitted_run_id: null, last_error_code: "ELIGIBILITY_NONE" });
  }, 60_000);
});

/**
 * The dev MCP check G5 could not run (mcp-test-results 20261017T204625Z): a group whose only member is the test-only
 * fake, and a subscription over it with `pacing.mode: score`. `fake` is accepted there only because serve registered
 * the fake adapter (the test switch); `src/config/fake-model-groups.test.ts` pins the refusal without it.
 */
const DEV_FAKE = {
  model_groups: { "dev-fake": { members: [{ provider: "fake", model: "fake-model-1" }] } },
  capacity: {
    subscriptions: {
      "dev-fake-sub": {
        providers: ["fake"],
        windows: [{ id: "h1", length_seconds: 3600, reset: { kind: "rolling" } }],
      },
    },
    pacing: { mode: "score" },
  },
};
const INSPECT = { objective: "Look", trust_profile: "inspect-untrusted" };
// A run on the fake needs its compile matrix, verified on linux only (Q-35, NFR-PORT-02): on darwin every profile is
// PROFILE_PLATFORM_UNVERIFIED, so this suite runs on linux only, like the real-run suites in `serve.test.ts`.
const describeLinuxVerified = process.platform === "darwin" ? describe.skip : describe;

describeLinuxVerified("serve accepts the test-only fake in model_groups and capacity.subscriptions (T7.13, T6.13)", () => {
  beforeEach(() => {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...cfg, ...DEV_FAKE }));
  });

  it("delegate_task and enqueue_work route a dev-fake group to fake; explain_route and get_capacity show the pacing", async () => {
    const c = await connect();
    const done = async (runId: string) => {
      const deadline = Date.now() + 30_000;
      // biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
      let run: any;
      while (Date.now() < deadline) {
        run = (await call(c, "get_run", { run_id: runId })).body;
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return run;
    };

    const delegated = await call(c, "delegate_task", {
      ...INSPECT,
      workspace_path: repo,
      routing: { model_group: "dev-fake" },
    });
    expect(delegated.isError, JSON.stringify(delegated.body)).toBe(false);
    expect((await done(delegated.body.run_id)).status).toBe("SUCCEEDED");
    const explained = (await call(c, "explain_route", { run_id: delegated.body.run_id })).body;
    expect(explained.selected_provider).toBe("fake");
    expect(explained.candidates.map((m: { provider: string }) => m.provider)).toEqual(["fake/fake-model-1"]);
    expect(explained.candidates[0].terms).toHaveProperty("pacing");
    expect(explained.features).toMatchObject({
      model_group: "dev-fake",
      pacing_mode: "score",
      candidate_subscription: { fake: "dev-fake-sub" },
    });
    expect(explained.deciding_factors).toEqual(
      expect.arrayContaining(["model group dev-fake: member fake/fake-model-1 chosen", "pacing: fake pace unknown"]),
    );

    const capacity = (await call(c, "get_capacity", {})).body;
    expect(capacity.pacing).toEqual([
      expect.objectContaining({ subscription: "dev-fake-sub", providers: ["fake"], mode: "score" }),
    ]);

    const queued = await call(c, "enqueue_work", {
      project_id: "web",
      request: { ...INSPECT, routing: { model_group: "dev-fake" } },
    });
    expect(queued.isError, JSON.stringify(queued.body)).toBe(false);
    const deadline = Date.now() + 30_000;
    // biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
    let item: any;
    while (Date.now() < deadline) {
      item = (await call(c, "list_work", {})).body.items.find(
        (i: { work_item_id: string }) => i.work_item_id === queued.body.work_item_id,
      );
      if (item.admitted_run_id !== null || item.terminal_at !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(item.admitted_run_id, JSON.stringify(item)).not.toBeNull();
    expect((await done(item.admitted_run_id)).status).toBe("SUCCEEDED");
    const admitted = (await call(c, "explain_route", { run_id: item.admitted_run_id })).body;
    expect(admitted.features).toMatchObject({ model_group: "dev-fake", members: [{ key: "fake/fake-model-1" }] });
  }, 60_000);
});
