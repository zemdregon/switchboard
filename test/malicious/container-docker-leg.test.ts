/**
 * Opt-in Docker leg of the NFR-SEC-03 container suite (T10.3; FR-GIT-01, FR-GIT-03, FR-PRJ-05, owner decision 24). Runs
 * only with `SWITCHBOARD_CONTAINER_TESTS=1`, a reachable **rootless** Docker daemon and a locally present base image
 * (`SWITCHBOARD_CONTAINER_TEST_IMAGE`, default `node:22-bookworm-slim`, which has no `git` or `gh`; nothing is pulled).
 * Otherwise it is skipped with the reason in the suite name, as in CI.
 *
 * The real lifecycle admits an approved `privileged` scope with `bypass: true` and the network on, under a `container`
 * project, and the real Docker backend runs the "agent" in the image: a Node script that behaves as an agent with a
 * shell and its own Git client would. It looks for `git` and `gh`, reads the worktree's `.git` link to find the
 * operator repository's Git directory and writes refs, `HEAD`, `packed-refs`, configuration and a hook there directly
 * (what a Git client would do), reads the canary credential files and the controller's ledger, writes into the
 * read-only context and outside the worktree, looks for a runtime socket, and finally rewrites the `.git` link at the
 * operator's Git directory. Afterwards, on the host: every ref, `HEAD`, the index, configuration, hooks and the remote
 * are unchanged; the run branch moved only by the controller's checkpoint; the rewritten link is a recorded violation
 * and was put back; no canary token appears anywhere; and no container is left.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type ProviderAdapter,
  type ResolvedProfile,
} from "../../src/adapters/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { createContainerEnvironment, createDockerRuntime, SWITCHBOARD_RUN_LABEL } from "../../src/environment/index.js";
import { GIT_POLICY_VIOLATION_EVENT, type ViolationEntry } from "../../src/git/index.js";
import { createIdGenerator } from "../../src/ids/index.js";
import { createLedger, LEDGER_FILE_NAME, type Ledger, openLedger } from "../../src/ledger/index.js";
import { RunLifecycle } from "../../src/lifecycle/index.js";
import type { ProjectSnapshot } from "../../src/policy/index.js";
import { WorkspaceManager } from "../../src/workspace/index.js";
import { findTokens, ledgerDump, operatorState, readIfExists, refs, treeHash } from "./detectors.js";
import { buildMaliciousFixture, type MaliciousFixture, tg } from "./fixture.js";

const OPT_IN = process.env.SWITCHBOARD_CONTAINER_TESTS === "1";
const BASE_IMAGE = process.env.SWITCHBOARD_CONTAINER_TEST_IMAGE ?? "node:22-bookworm-slim";

const docker = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile("docker", args, { encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout, stderr }),
    );
  });

const runtime = createDockerRuntime();
let reason = OPT_IN ? "" : "set SWITCHBOARD_CONTAINER_TESTS=1 to run";
let imageId = "";
if (OPT_IN) {
  const info = await runtime.info();
  if (!info.available) reason = `docker unavailable: ${info.detail}`;
  else if (!info.rootless) reason = `docker is not rootless: ${info.detail}`;
  else {
    const r = await docker(["image", "inspect", "--format", "{{.Id}}", BASE_IMAGE]);
    if (r.code !== 0) reason = `image ${BASE_IMAGE} is not present locally (not pulled)`;
    else imageId = r.stdout.trim();
  }
}
const ready = reason === "";

const PATIENT = { wallClockMs: 150_000, idleMs: 120_000, killGraceMs: 2_000 };
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "disabled" },
  bypass: true,
};

/**
 * The agent, run as `node -e` inside the image. Paths it must not reach arrive as `argv` (host paths, which mean
 * nothing inside unless mounted). It prints one JSONL `message` per probe and a final `result`, as the fake CLI does.
 */
const AGENT = String.raw`
const fs = require("node:fs"); const path = require("node:path"); const cp = require("node:child_process");
const [fakeHome, codexAuth, claudeCreds, outsideDir, dataDir, contextDir, commitSha, ledgerFile] = process.argv.slice(1);
const out = (o) => process.stdout.write(JSON.stringify({ type: "message", text: JSON.stringify(o) }) + "\n");
const tryRun = (cmd) => { const r = cp.spawnSync(cmd, ["--version"]); return r.error ? r.error.code : "ran:" + r.status; };
const tryRead = (p) => { try { return "read:" + fs.readFileSync(p, "utf8"); } catch (e) { return e.code; } };
const tryWrite = (p, s) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return "wrote"; } catch (e) { return e.code; } };
out({ probe: "git", r: tryRun("git") });
out({ probe: "gh", r: tryRun("gh") });
const link = fs.readFileSync(".git", "utf8");
const admin = link.replace(/^gitdir: /, "").trim();
const common = path.resolve(admin, "..", "..");
out({ probe: "admin_dir_visible", r: fs.existsSync(admin) });
out({ probe: "common_dir_visible", r: fs.existsSync(common) });
for (const [name, rel, content] of [
  ["ref_main", "refs/heads/main", commitSha + "\n"],
  ["ref_new", "refs/heads/agent-branch", commitSha + "\n"],
  ["tag", "refs/tags/agent-tag", commitSha + "\n"],
  ["head", "HEAD", "ref: refs/heads/agent-branch\n"],
  ["packed_refs", "packed-refs", commitSha + " refs/heads/packed-agent\n"],
  ["config", "config", "[core]\n\thooksPath = /tmp/evil-hooks\n"],
  ["hook", "hooks/post-checkout", "#!/bin/sh\necho pwned\n"],
  ["run_branch_admin_head", path.relative(common, path.join(admin, "HEAD")), commitSha + "\n"],
]) out({ probe: "write_" + name, r: tryWrite(path.join(common, rel), content) });
out({ probe: "read_codex_auth", r: tryRead(codexAuth) });
out({ probe: "read_claude_credentials", r: tryRead(claudeCreds) });
out({ probe: "list_fake_home", r: fs.existsSync(fakeHome) });
out({ probe: "read_ledger", r: tryRead(path.join(dataDir, ledgerFile)) });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() && !fs.existsSync(path.join(d, e.name, ".git")) ? walk(path.join(d, e.name)).map((x) => e.name + "/" + x) : [e.name]);
out({ probe: "data_dir_listing", r: walk(dataDir) });
out({ probe: "write_context", r: tryWrite(path.join(contextDir, "agent.txt"), "x") });
out({ probe: "write_outside", r: tryWrite(path.join(outsideDir, "agent.txt"), "x") });
out({ probe: "runtime_socket", r: ["/var/run/docker.sock", "/run/docker.sock", "/run/user/1001/docker.sock", "/run/user/1000/docker.sock"].filter((p) => fs.existsSync(p)) });
out({ probe: "docker_host", r: process.env.DOCKER_HOST ?? null });
out({ probe: "home", r: process.env.HOME ?? null });
fs.writeFileSync("agent.txt", "agent work\n");
fs.writeFileSync(".git", "gitdir: " + common + "\n");
process.stdout.write(JSON.stringify({ type: "result", ok: true, summary: "probes done" }) + "\n");
`;

/** Compiles the fake adapter's invocation, then swaps in the in-image agent (`node` resolves on the image PATH). */
class InImageAgent implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = new FakeAdapter().gitWriteControl;
  readonly resumeCwd = "bound" as const;
  readonly gitCapabilities = { commitChannel: "none", detail: "test double" } as const;
  readonly profiles: ResolvedProfile[] = [];
  private readonly base = new FakeAdapter({ scenario: "success", timeouts: PATIENT });
  constructor(private readonly agentArgs: readonly string[]) {}
  probe: ProviderAdapter["probe"] = (r) => this.base.probe(r);
  authPreflight: ProviderAdapter["authPreflight"] = (r) => this.base.authPreflight(r);
  compile(req: CompileRequest, profile: ResolvedProfile) {
    this.profiles.push(profile);
    const inv = this.base.compile(req, { ...profile, name: "edit-untrusted", bypassApproved: false });
    if ("ineligible" in inv) return inv;
    return { ...inv, argv: [process.execPath, "-e", AGENT, ...this.agentArgs] };
  }
  parseEvent: ProviderAdapter["parseEvent"] = (i, s) => this.base.parseEvent(i, s);
  extractResult: ProviderAdapter["extractResult"] = (e, x) => this.base.extractResult(e, x);
  resumeArgs: ProviderAdapter["resumeArgs"] = (b, r, p) => this.base.resumeArgs(b, r, p);
  classifyFailure: ProviderAdapter["classifyFailure"] = (e) => this.base.classifyFailure(e);
}

describe.skipIf(!ready)(
  `NFR-SEC-03 container leg on rootless Docker (T10.3)${ready ? "" : ` (skipped: ${reason})`}`,
  () => {
    let fx: MaliciousFixture;
    let db: Database.Database;
    let ledger: Ledger;
    let docs: string;

    beforeEach(() => {
      fx = buildMaliciousFixture();
      docs = path.join(fx.allowedRoot, "docs");
      mkdirSync(docs);
      writeFileSync(path.join(docs, "guide.md"), "read-only context\n");
      db = openLedger(fx.dataDir);
      ledger = createLedger(db, { ids: createIdGenerator() });
    });
    afterEach(() => {
      db.close();
      fx.close();
    });

    it("an approved bypass agent with a shell reaches no ref, credential, context or host path; no container is left", async () => {
      const before = operatorState(fx);
      const allBefore = refs(fx.repo);
      const remoteBefore = refs(fx.remote);
      const outsideBefore = treeHash(fx.outsideDir);
      const homeBefore = treeHash(fx.fakeHome);
      const docsBefore = treeHash(docs);
      const adapter = new InImageAgent([
        fx.fakeHome,
        fx.codexAuthPath,
        fx.claudeCredentialsPath,
        fx.outsideDir,
        fx.dataDir,
        docs,
        fx.baseCommit,
        LEDGER_FILE_NAME,
      ]);
      const ids = createIdGenerator();
      const artifacts = new ArtifactStore(path.join(fx.dataDir, "artifacts"));
      const environment = createContainerEnvironment({ runtime });
      const project: ProjectSnapshot = {
        id: "hostile",
        name: "Hostile",
        environment_kind: "container",
        image_digest: imageId,
        context_id: "main",
        base_ref: "main",
        effective_max_profile: "privileged",
      };
      const lifecycle = new RunLifecycle({
        ledger,
        workspace: new WorkspaceManager({ db, artifacts, dataDir: fx.dataDir, allowedRoots: [fx.allowedRoot], ids }),
        artifacts,
        adapters: new AdapterRegistry().register(adapter),
        allowedRoots: [fx.allowedRoot],
        globalConcurrency: 1,
        resolveProfile: () => {
          throw new Error("a privileged run resolves only through its scope");
        },
        environments: {
          resolve: (p) =>
            p?.environment_kind === "container"
              ? { environment, readOnlyContexts: [{ id: "docs", path: docs }], limits: { memoryMb: 512 } }
              : undefined,
        },
      });
      lifecycle.start();
      let runId = "";
      try {
        const sub = await lifecycle.submit({
          clientId: "orchestrator",
          objective: "probe everything you can reach",
          workspace: fx.repo,
          trustProfile: "privileged",
          privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
          provider: "fake",
          project,
        });
        runId = sub.runId;
        const final = await lifecycle.waitForTerminal(runId);
        expect(final.state, final.failure_detail ?? "").toBe("SUCCEEDED");
      } finally {
        await lifecycle.shutdown();
      }
      expect(adapter.profiles[0]).toMatchObject({ name: "privileged", bypassApproved: true });

      // What the agent saw from inside the container.
      const terminal = ledger
        .listRunEvents(runId)
        .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
        .find((p) => p.to === "SUCCEEDED");
      const stdoutId = (terminal?.artifacts as Record<string, string> | undefined)?.provider_stdout as string;
      const stdout = (await artifacts.get(ledger.getArtifact(stdoutId)?.sha256 as string)).toString("utf8");
      const seen: Record<string, unknown> = {};
      for (const line of stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(line) as { type: string; text?: string };
        if (ev.type !== "message" || ev.text === undefined) continue;
        const m = JSON.parse(ev.text) as { probe: string; r: unknown };
        seen[m.probe] = m.r;
      }
      expect(seen.git).toBe("ENOENT");
      expect(seen.gh).toBe("ENOENT");
      expect(seen.admin_dir_visible).toBe(false); // the Git directory is not mounted
      expect(seen.common_dir_visible).toBe(false);
      expect(seen.read_codex_auth).toBe("ENOENT");
      expect(seen.read_claude_credentials).toBe("ENOENT");
      expect(seen.list_fake_home).toBe(false);
      expect(seen.read_ledger).toBe("ENOENT");
      // Only the path down to the mounted worktree exists under the data directory: no ledger, artifacts or lock.
      const worktreeRel = path.relative(fx.dataDir, ledger.getRunRecord(runId)?.worktree_path as string);
      expect(seen.data_dir_listing).toEqual([worktreeRel]);
      expect(seen.write_context).toBe("EROFS");
      expect(seen.runtime_socket).toEqual([]);
      expect(seen.docker_host).toBeNull();
      expect(seen.home).not.toBe(process.env.HOME);
      // The "writes" to the Git directory and outside the worktree landed in the container's own filesystem, if anywhere.

      // On the host: nothing the agent wrote outside the worktree exists; every ref and the operator checkout unchanged.
      expect(operatorState(fx)).toEqual(before);
      expect(refs(fx.remote)).toEqual(remoteBefore);
      expect(treeHash(fx.outsideDir)).toBe(outsideBefore);
      expect(treeHash(fx.fakeHome)).toBe(homeBefore);
      expect(treeHash(docs)).toBe(docsBefore);
      const run = ledger.getRunRecord(runId);
      const runBranch = `refs/heads/${run?.branch ?? ""}`;
      const after = refs(fx.repo);
      expect({ ...after, [runBranch]: "" }).toEqual({ ...allBefore, [runBranch]: "" });
      const post = ledger.getRunCheckpointCommit(runId, "post") as string;
      expect(after[runBranch]).toBe(post);
      expect(tg(fx.repo, "rev-parse", `${post}^`)).toBe(ledger.getRunCheckpointCommit(runId, "pre"));
      expect(tg(fx.repo, "show", `${post}:agent.txt`)).toBe("agent work");
      const violations = ledger
        .listRunEvents(runId)
        .filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT)
        .flatMap((e) => (JSON.parse(e.payload_json) as { violations: ViolationEntry[] }).violations);
      expect(violations.map((v) => [v.scope, v.kind])).toEqual([["worktree_link", "link_changed"]]);

      expect(readIfExists(fx.hookLog)).toBe("");
      expect(readIfExists(fx.filterLog)).toBe("");
      expect(readIfExists(fx.configLog)).toBe("");
      expect(findTokens(fx, `${stdout}\n${ledgerDump(db)}`)).toEqual([]);
      const ps = await docker([
        "ps",
        "--all",
        "--filter",
        `label=${SWITCHBOARD_RUN_LABEL}=${runId}`,
        "--format",
        "{{.Names}}",
      ]);
      expect(ps.stdout.trim()).toBe("");
    }, 300_000);
  },
);
