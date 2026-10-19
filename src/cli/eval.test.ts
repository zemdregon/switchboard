/**
 * `switchboard eval` (T8.14; FR-OPS-06, LLD §20.13). The command is skipped in CI, refuses a real provider without a
 * live budget file before any run is admitted, and on the test-only fake adapter replays a fixture suite end to end
 * through the same wiring an operator gets. No Docker: the container runtime and the grader's spawn are injected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerRuntime } from "../environment/index.js";
import { argvHasNetworkNone, GRADER_TESTS_DIR, type GraderExec } from "../eval/index.js";
import { LEDGER_FILE_NAME } from "../ledger/index.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { TEST_FAKE_ADAPTER_ENV, TEST_FAKE_ADAPTER_VALUE, TEST_FAKE_SCENARIO_ENV } from "./serve.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
const DIGEST = `sha256:${"d".repeat(64)}`;

let tmp: string;
let repo: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-evalcli-")));
  repo = path.join(tmp, "roots", "web");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "x\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(tmp, "roots")],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      projects: [
        { id: "web", name: "Web", contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main" }] },
      ],
    }),
  );
  const evalDir = path.join(dataDir, "eval");
  mkdirSync(path.join(evalDir, "bundles", "t1"), { recursive: true });
  writeFileSync(path.join(evalDir, "bundles", "t1", "check.test.mjs"), "// hidden\n");
  writeFileSync(
    path.join(evalDir, "fixture.json"),
    JSON.stringify({
      schema_version: 1,
      project: "web",
      grader: { image_digest: DIGEST, test_command: ["node", `${GRADER_TESTS_DIR}/check.test.mjs`] },
      tasks: [
        {
          id: "t1",
          base_ref: "main",
          objective: "make the hidden test pass",
          hidden_tests: "bundles/t1",
        },
      ],
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function io(env: Record<string, string | undefined>, extra: Partial<CliIo> = {}) {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      env: { PATH: process.env.PATH, HOME: tmp, ...env },
      ...extra,
    } as CliIo,
    out: () => out,
    err: () => err,
  };
}

describe("switchboard eval (T8.14, FR-OPS-06)", () => {
  it("is skipped in CI: exit 0, EVAL_SKIPPED_IN_CI, nothing opened", async () => {
    const t = io({ CI: "true" });
    const code = await main(["eval", "run", "fixture", "--provider", "claude", "--config", configPath, "--json"], t.io);
    expect(code).toBe(0);
    expect(JSON.parse(t.out()).skipped).toBe("EVAL_SKIPPED_IN_CI");
    expect(existsSync(path.join(dataDir, LEDGER_FILE_NAME))).toBe(false);
  });

  it("refuses a real provider without a live budget file before any run is admitted", async () => {
    const t = io({});
    const code = await main(["eval", "run", "fixture", "--provider", "claude", "--config", configPath, "--json"], t.io);
    expect(code).toBe(1);
    expect(JSON.parse(t.out()).error.code).toBe("EVAL_LIVE_BUDGET_REQUIRED");
    // Refused before the lock and the ledger: no run row can exist.
    expect(existsSync(path.join(dataDir, LEDGER_FILE_NAME))).toBe(false);

    const budget = path.join(tmp, "budget.json");
    writeFileSync(budget, JSON.stringify({ provider: "codex", max_runs: 1 }));
    const t2 = io({});
    const args = ["eval", "run", "fixture", "--provider", "claude", "--live-budget", budget, "--config", configPath];
    expect(await main(args, t2.io)).toBe(1);
    expect(t2.err()).toContain("EVAL_LIVE_BUDGET_REQUIRED");
    expect(existsSync(path.join(dataDir, LEDGER_FILE_NAME))).toBe(false);
  });

  it("rejects --live-budget outside eval and an unknown subcommand", async () => {
    const t = io({});
    expect(await main(["doctor", "--live-budget", "x", "--config", configPath], t.io)).toBe(2);
    expect(await main(["eval", "replay", "fixture", "--config", configPath], io({}).io)).toBe(2);
  });

  it("replays the fixture suite on the fake adapter, grades network-off and lists the results", async () => {
    const argvs: string[][] = [];
    const graderExec: GraderExec = (argv) => {
      argvs.push([...argv]);
      return Promise.resolve({ code: argvHasNetworkNone(argv) ? 0 : 1 });
    };
    const containerRuntime = () =>
      createDockerRuntime({
        clientPath: "/opt/fake/docker",
        baseEnv: {},
        exec: (args) => {
          if (args[0] === "info")
            return Promise.resolve({ code: 0, stdout: '29.8.2\t["name=rootless"]\n', stderr: "" });
          if (args[0] === "image")
            return Promise.resolve({ code: 0, stdout: `sha256:${"e".repeat(64)}\t${DIGEST}\n`, stderr: "" });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      });
    const env = { [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE, [TEST_FAKE_SCENARIO_ENV]: "success" };
    const t = io(env, { graderExec, containerRuntime });
    const code = await main(["eval", "run", "fixture", "--provider", "fake", "--config", configPath, "--json"], t.io);
    expect(t.err()).not.toContain("switchboard:");
    expect(code).toBe(0);
    const report = JSON.parse(t.out());
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      suite: "fixture",
      task_id: "t1",
      provider: "fake",
      pass: true,
      test_exit_code: 0,
      run_state: "SUCCEEDED",
      usage: [{ input_tokens: 10, output_tokens: 5 }],
    });
    expect(argvs).toHaveLength(1);
    expect(argvHasNetworkNone(argvs[0] as string[])).toBe(true);

    const r = io({});
    expect(await main(["eval", "results", "fixture", "--config", configPath], r.io)).toBe(0);
    expect(r.out()).toContain("eval fixture: 1/1 passed");
  });
});
