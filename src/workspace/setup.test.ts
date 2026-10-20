/**
 * ADR-0071: the project setup runner on a temporary Git worktree, with local fixtures only (no network). Most cases
 * use the bridge without bubblewrap (`wrap`), so they run where unprivileged user namespaces are blocked; the last
 * case runs the real sandbox and is skipped when this host's bubblewrap probe fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeOnly, detectOuterSandbox } from "../exec/index.js";
import type { ProjectSetupSnapshot } from "../policy/index.js";
import { createProjectSetup, type ProjectSetupOptions, SETUP_MARKER_FILE } from "./setup.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/**
 * The fake install: writes `node_modules/pkg/installed.txt`, dumps its environment to `env.json` under
 * `node_modules`, and asks the proxy named by `HTTPS_PROXY` for each host in the probe list (empty unless a test
 * writes one in), recording the status lines. `FAIL` in the lockfile exits 3; `SLEEP` sleeps; `DIRTY` writes an unignored file.
 */
const INSTALL = `
const fs = require("node:fs");
const net = require("node:net");
const lock = fs.readFileSync("package-lock.json", "utf8");
if (lock.includes("FAIL")) { process.stderr.write("install failed token=sk-ant-api03-${"x".repeat(40)}\\n"); process.exit(3); }
if (lock.includes("SLEEP")) setTimeout(() => {}, 60000);
fs.mkdirSync("node_modules/pkg", { recursive: true });
fs.writeFileSync("node_modules/pkg/installed.txt", lock);
fs.writeFileSync("node_modules/env.json", JSON.stringify(process.env));
if (lock.includes("DIRTY")) fs.writeFileSync("untracked-output.txt", "x");
const hosts = (process.env.PROBE_HOSTS || "").split(",").filter(Boolean);
const out = [];
const u = new URL(process.env.HTTPS_PROXY);
const next = () => {
  const h = hosts.shift();
  if (h === undefined) { fs.writeFileSync("node_modules/probes.json", JSON.stringify(out)); console.log("installed"); return; }
  const s = net.connect(Number(u.port), u.hostname, () => s.write("CONNECT " + h + ":443 HTTP/1.1\\r\\n\\r\\n"));
  s.once("data", (d) => { out.push([h, d.toString().split("\\r\\n")[0]]); s.destroy(); next(); });
  s.on("error", () => { out.push([h, "error"]); next(); });
};
if (!lock.includes("SLEEP")) next();
`;

let root: string;
let repo: string;
let worktree: string;
let dataDir: string;
let script: string;
let upstream: net.Server;
let upstreamPort: number;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-setup-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(repo, "package-lock.json"), "lock-v1\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  worktree = path.join(root, "wt");
  g(repo, "worktree", "add", "-q", "--detach", worktree, "HEAD");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  script = path.join(root, "install.cjs");
  writeFileSync(script, INSTALL);
  upstream = net.createServer((s) => s.end());
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

const SETUP = (o: Partial<ProjectSetupSnapshot> = {}): ProjectSetupSnapshot => ({
  commands: [[process.execPath, script]],
  network_hosts: ["registry.npmjs.org"],
  cache: "pnpm",
  timeout_seconds: 60,
  env: { CI: "true" },
  ...o,
});

/** A runner whose commands go through the bridge only; the proxy dials the local listener for every allowed name. */
const runner = (extra: Partial<ProjectSetupOptions> = {}) =>
  createProjectSetup({
    dataDir,
    baseEnv: {
      PATH: process.env.PATH,
      HOME: "/home/operator",
      SB_PLANTED_SECRET: "planted-secret-value",
      GH_TOKEN: "ghp_planted",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GIT_ASKPASS: "/bin/false",
    },
    wrap: (argv, socketPath) => bridgeOnly(socketPath, process.execPath, argv),
    proxy: {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      allowAddress: () => true,
      dial: () => net.connect(upstreamPort, "127.0.0.1"),
    },
    killGraceMs: 200,
    ...extra,
  });

async function run(setup: ProjectSetupSnapshot, r = runner()) {
  const plan = await r.plan(worktree, setup);
  const result = await r.start({ runId: "run_1", projectId: "web", worktreePath: worktree, setup, plan }).done;
  return { plan, result };
}

const markerFile = () => path.join(g(worktree, "rev-parse", "--absolute-git-dir"), SETUP_MARKER_FILE);

describe("project setup runner (ADR-0071)", () => {
  it("runs the commands in the worktree with a minimal environment and records a marker", async () => {
    const { plan, result } = await run(SETUP());
    expect(plan.skip).toBe(false);
    expect(result).toMatchObject({ outcome: "succeeded", confined: false });
    expect(readFileSync(path.join(worktree, "node_modules/pkg/installed.txt"), "utf8")).toBe("lock-v1\n");
    const env = JSON.parse(readFileSync(path.join(worktree, "node_modules/env.json"), "utf8")) as Record<
      string,
      string
    >;
    // Nothing of the controller's environment but PATH: no planted secret, token, SSH agent or Git variable.
    expect(env.SB_PLANTED_SECRET).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_"))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain("planted");
    expect(env.HOME).toBe(path.join(dataDir, "setup", "web", "home"));
    expect(env.COREPACK_HOME).toBe(path.join(dataDir, "caches", "corepack"));
    // cache: pnpm points the store at the shared cache directory.
    expect(env.npm_config_store_dir).toBe(path.join(dataDir, "caches", "pnpm-store"));
    expect(env.PNPM_STORE_DIR).toBe(path.join(dataDir, "caches", "pnpm-store"));
    expect(env.CI).toBe("true");
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.npm_config_https_proxy).toBe(env.HTTPS_PROXY);
    expect(JSON.parse(readFileSync(markerFile(), "utf8"))).toEqual({
      v: 1,
      lockfile_sha256: plan.lockfileSha256,
      setup_sha256: plan.setupSha256,
    });
    // The marker lives in the worktree's own Git directory, outside the worktree.
    expect(markerFile().startsWith(worktree)).toBe(false);
  });

  it("skips on a marker for the same lockfile and setup, and runs again when either changes", async () => {
    const r = runner();
    await run(SETUP(), r);
    expect((await r.plan(worktree, SETUP())).skip).toBe(true);
    expect((await r.plan(worktree, SETUP({ cache: "npm" }))).skip).toBe(false);
    writeFileSync(path.join(worktree, "package-lock.json"), "lock-v2\n");
    expect((await r.plan(worktree, SETUP())).skip).toBe(false);
  });

  it("reaches only the listed hosts through the proxy", async () => {
    const setup = SETUP({ network_hosts: ["registry.npmjs.org"] });
    // The hosts to probe are written into the fixture (a setup command cannot be given arbitrary variables).
    writeFileSync(script, INSTALL.replace('process.env.PROBE_HOSTS || ""', '"registry.npmjs.org,evil.example"'));
    const { result } = await run(setup);
    expect(result.outcome).toBe("succeeded");
    expect(JSON.parse(readFileSync(path.join(worktree, "node_modules/probes.json"), "utf8"))).toEqual([
      ["registry.npmjs.org", "HTTP/1.1 200 Connection Established"],
      ["evil.example", "HTTP/1.1 403 Forbidden"],
    ]);
    expect(result.proxy).toEqual({ allowed: 1, refused: 1 });
  });

  it("fails with the command's exit code, no marker, and keeps the output for the artifact", async () => {
    writeFileSync(path.join(worktree, "package-lock.json"), "FAIL\n");
    const { result } = await run(SETUP());
    expect(result).toMatchObject({ outcome: "failed", reason: "command_failed" });
    expect(result.commands[0]?.exitCode).toBe(3);
    expect(result.commands[0]?.stderr.toString()).toContain("install failed");
    expect(existsSync(markerFile())).toBe(false);
  });

  it("times out at timeout_seconds", async () => {
    writeFileSync(path.join(worktree, "package-lock.json"), "SLEEP\n");
    const { result } = await run(SETUP({ timeout_seconds: 1 }));
    expect(result).toMatchObject({ outcome: "timeout", reason: "timeout" });
    expect(existsSync(markerFile())).toBe(false);
  });

  it("fails when setup leaves a file Git does not ignore (it could otherwise reach a commit)", async () => {
    writeFileSync(path.join(worktree, "package-lock.json"), "DIRTY\n");
    g(worktree, "add", "package-lock.json");
    g(worktree, "commit", "-q", "-m", "dirty lock");
    const { result } = await run(SETUP());
    expect(result).toMatchObject({ outcome: "failed", reason: "outputs_not_ignored" });
    expect(existsSync(markerFile())).toBe(false);
  });

  it("refuses to run unconfined when bubblewrap is unavailable", async () => {
    const r = createProjectSetup({
      dataDir,
      baseEnv: { PATH: process.env.PATH },
      outerSandbox: {
        platform: "linux",
        mechanisms: {
          bubblewrap: { mechanism: "bubblewrap", available: false, path: null, version: null, detail: "absent" },
          prlimit: { mechanism: "prlimit", available: false, path: null, version: null, detail: "absent" },
          landlock: { mechanism: "landlock", available: false, path: null, version: null, detail: "absent" },
        },
      },
    });
    const { result } = await run(SETUP(), r);
    expect(result).toMatchObject({ outcome: "failed", reason: "sandbox_unavailable", confined: true, commands: [] });
    expect(existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });
});

const sandbox = await detectOuterSandbox();
describe.skipIf(!sandbox.mechanisms.bubblewrap.available)("project setup in bubblewrap (ADR-0071)", () => {
  it("has no direct network, sees no operator home, and reaches the proxy through the bridge", async () => {
    const operatorHome = path.join(root, "operator-home");
    mkdirSync(operatorHome);
    writeFileSync(path.join(operatorHome, "auth.json"), "{}");
    // Under the (ignored) node_modules of the worktree: the sandbox hides /tmp, where this test's root lives.
    mkdirSync(path.join(worktree, "node_modules"));
    const probe = path.join(worktree, "node_modules", "probe.cjs");
    writeFileSync(
      probe,
      `
const fs = require("node:fs"); const net = require("node:net");
const r = { home_visible: fs.existsSync(${JSON.stringify(path.join(operatorHome, "auth.json"))}),
  data_visible: fs.existsSync(${JSON.stringify(path.join(dataDir, "secret.txt"))}) };
const d = net.connect(443, "1.1.1.1");
d.on("error", (e) => { r.direct = e.code; done(); });
d.on("connect", () => { r.direct = "connected"; d.destroy(); done(); });
let n = 0;
function done() { if (++n < 2) return; fs.mkdirSync("node_modules", { recursive: true });
  fs.writeFileSync("node_modules/sandbox.json", JSON.stringify(r)); }
const u = new URL(process.env.HTTPS_PROXY);
const s = net.connect(Number(u.port), u.hostname, () => s.write("CONNECT evil.example:443 HTTP/1.1\\r\\n\\r\\n"));
s.once("data", (b) => { r.proxy = b.toString().split("\\r\\n")[0]; s.destroy(); done(); });
`,
    );
    writeFileSync(path.join(dataDir, "secret.txt"), "x");
    const r = createProjectSetup({
      dataDir,
      baseEnv: { PATH: process.env.PATH, HOME: operatorHome },
      outerSandbox: sandbox,
    });
    const { result } = await run(SETUP({ commands: [[process.execPath, probe]] }), r);
    expect(result.commands[0]?.stderr.toString()).toBe("");
    expect(result).toMatchObject({ outcome: "succeeded", confined: true });
    expect(JSON.parse(readFileSync(path.join(worktree, "node_modules/sandbox.json"), "utf8"))).toEqual({
      home_visible: false,
      data_visible: false,
      direct: "ENETUNREACH",
      proxy: "HTTP/1.1 403 Forbidden",
    });
  });
});
