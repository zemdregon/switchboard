/**
 * Opt-in Docker leg of the container environment (T10.1 "Done when"; FR-PRJ-05, ADR-0020, ADR-0052). Runs only with
 * `SWITCHBOARD_CONTAINER_TESTS=1`, a reachable **rootless** Docker daemon and a locally present base image
 * (`SWITCHBOARD_CONTAINER_TEST_IMAGE`, default `node:22-bookworm-slim`; nothing is pulled). Otherwise every test is
 * skipped with the reason in the suite name. No provider CLI is involved: the "provider" is the image's `sh`.
 *
 * What it shows on a live runtime:
 * - only the run worktree (writable) and the declared read-only context are mounted; no home, data or socket mount;
 * - the container runs with no network interfaces but loopback, as uid 0, unprivileged, with the labels and limits;
 * - `--rm` and `teardown` leave no container behind, teardown is idempotent and removes a still-running container;
 * - an image with `git` on its `PATH` (a locally committed derivative of the base image) starts no run.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Invocation, ResolvedProfile } from "../adapters/types.js";
import { supervise } from "../exec/supervisor.js";
import {
  containerName,
  createContainerEnvironment,
  probeContainerName,
  SWITCHBOARD_PROJECT_LABEL,
  SWITCHBOARD_ROLE_LABEL,
  SWITCHBOARD_RUN_LABEL,
} from "./container.js";
import { createDockerRuntime } from "./docker-runtime.js";
import { type EnvironmentEvent, EnvironmentRefusal, type RunContext } from "./types.js";

const OPT_IN = process.env.SWITCHBOARD_CONTAINER_TESTS === "1";
const BASE_IMAGE = process.env.SWITCHBOARD_CONTAINER_TEST_IMAGE ?? "node:22-bookworm-slim";

const docker = (args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = execFile(
      "docker",
      args,
      { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

const runtime = createDockerRuntime();
let reason = OPT_IN ? "" : "set SWITCHBOARD_CONTAINER_TESTS=1 to run";
let baseImageId = "";
if (OPT_IN) {
  const info = await runtime.info();
  if (!info.available) reason = `docker unavailable: ${info.detail}`;
  else if (!info.rootless) reason = `docker is not rootless: ${info.detail}`;
  else {
    const r = await docker(["image", "inspect", "--format", "{{.Id}}", BASE_IMAGE]);
    if (r.code !== 0) reason = `image ${BASE_IMAGE} is not present locally (not pulled)`;
    else baseImageId = r.stdout.trim();
  }
}
const ready = reason === "";

const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

const newRunId = (): string =>
  `T101${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)
    .toString(36)
    .toUpperCase()}`;

function invocation(script: string, extra: Partial<Invocation> = {}): Invocation {
  return {
    transport: "subprocess-jsonl",
    argv: ["/bin/sh", "-c", script],
    env: {},
    envAllowlist: ["PATH", "HOME", "SB_T101_FORWARDED"],
    cwd: "/",
    outputFormat: "jsonl",
    timeouts: { wallClockMs: 90_000, idleMs: 60_000, killGraceMs: 2_000 },
    policyFlags: [],
    expectedExitCodes: [0],
    maxLineBytes: 65_536,
    ...extra,
  };
}

describe.skipIf(!ready)(`container environment on rootless Docker${ready ? "" : ` (skipped: ${reason})`}`, () => {
  let scratch: string;
  let worktree: string;
  let context: string;
  const events: EnvironmentEvent[] = [];
  const env = createContainerEnvironment({ runtime, onEvent: (e) => events.push(e) });
  const runIds: string[] = [];
  let gitImageTag = "";

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-t101-")));
    worktree = path.join(scratch, "worktree");
    context = path.join(scratch, "context");
    // mkdtemp made `scratch`; the two mount sources are plain directories under it.
    for (const d of [worktree, context]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(context, "readme.txt"), "read-only context\n");
  });

  afterAll(async () => {
    for (const id of runIds) await env.teardown({ runId: id });
    if (gitImageTag) await docker(["rmi", "--force", gitImageTag]);
    rmSync(scratch, { recursive: true, force: true });
  });

  function run(runId: string, over: Partial<RunContext> = {}): RunContext {
    runIds.push(runId);
    return {
      runId,
      projectId: "t101",
      worktreePath: worktree,
      readOnlyContexts: [{ id: "ctx", path: context }],
      profile: PROFILE,
      imageDigest: baseImageId,
      limits: { cpus: 1, memoryMb: 256, diskMb: 1024 },
      ...over,
    };
  }

  it("mounts only the worktree (rw) and the declared context (ro); no network, uid 0, labels, limits; removed at end", async () => {
    const runId = newRunId();
    // The "provider": writes into the worktree, tries the context, reports what it sees, then waits for stdin EOF.
    const script = [
      'echo "uid=$(id -u)"',
      'echo "home=$HOME"',
      'echo "fwd=$SB_T101_FORWARDED"',
      'echo "pwd=$(pwd)"',
      `echo written > "${worktree}/from-container.txt" && echo wt_write=ok || echo wt_write=fail`,
      `( echo x > "${context}/attempt.txt" ) 2>/dev/null && echo ctx_write=ok || echo ctx_write=fail`,
      'echo "nets=$(ls /sys/class/net | tr "\\n" " ")"',
      "echo READY",
      "read -r _line",
      "echo DONE",
    ].join("\n");
    const prepared = await env.prepare(run(runId), invocation(script));
    expect(prepared.container?.name).toBe(containerName(runId));
    expect(prepared.container?.executable).toBe("sh");
    expect(prepared.container?.forwardedEnv).toEqual(["SB_T101_FORWARDED"]);

    const lines: string[] = [];
    const sup = supervise({
      argv: prepared.invocation.argv,
      envAllowlist: prepared.invocation.envAllowlist,
      extraEnv: prepared.invocation.env,
      baseEnv: { ...process.env, SB_T101_FORWARDED: "yes" },
      keepStdinOpen: true,
      wallClockMs: 90_000,
      idleMs: 60_000,
      killGraceMs: 2_000,
    });
    // Wait for READY on stdout (the supervisor captures stdout; poll the live container's log instead).
    const deadline = Date.now() + 60_000;
    let inspected: Awaited<ReturnType<typeof runtime.inspect>> = null;
    while (Date.now() < deadline) {
      inspected = await runtime.inspect(containerName(runId));
      if (inspected?.running) {
        const logs = await docker(["logs", containerName(runId)]);
        if (logs.stdout.includes("READY")) break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(inspected?.running).toBe(true);

    // FR-PRJ-05: exactly the two declared mounts, at their own paths, with the right modes.
    expect(inspected?.mounts.map((m) => ({ ...m })).sort((a, b) => a.target.localeCompare(b.target))).toEqual(
      [
        { source: worktree, target: worktree, readonly: false },
        { source: context, target: context, readonly: true },
      ].sort((a, b) => a.target.localeCompare(b.target)),
    );
    expect(inspected?.networkMode).toBe("none");
    expect(inspected?.privileged).toBe(false);
    expect(inspected?.labels).toMatchObject({
      [SWITCHBOARD_RUN_LABEL]: runId,
      [SWITCHBOARD_PROJECT_LABEL]: "t101",
      [SWITCHBOARD_ROLE_LABEL]: "run",
    });
    const host = await docker([
      "inspect",
      "--format",
      "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.Binds}} {{.Config.User}} {{.HostConfig.AutoRemove}}",
      containerName(runId),
    ]);
    const [memory, nanoCpus, pids, capDrop, secOpt, binds, user, autoRemove] = host.stdout.trim().split(" ");
    expect(memory).toBe(String(256 * 1024 * 1024));
    expect(nanoCpus).toBe(String(1e9));
    expect(pids).toBe("512");
    expect(capDrop).toContain("ALL");
    expect(secOpt).toContain("no-new-privileges");
    expect(binds).toBe("null"); // mounts came through --mount, not -v; nothing else bound
    expect(user).toBe("0:0");
    expect(autoRemove).toBe("true");

    sup.endStdin();
    const result = await sup.result;
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    lines.push(...result.stdout.toString("utf8").split("\n"));
    const got = Object.fromEntries(
      lines.filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]),
    );
    expect(got.uid).toBe("0");
    expect(got.home).not.toBe(process.env.HOME); // HOME is host-only: the image's own value applies
    expect(got.fwd).toBe("yes"); // an allowlisted, non-host-only name is copied in
    expect(got.pwd).toBe(worktree);
    expect(got.wt_write).toBe("ok");
    expect(got.ctx_write).toBe("fail");
    expect(got.nets?.trim()).toBe("lo");
    expect(lines).toContain("DONE");
    expect(readFileSync(path.join(worktree, "from-container.txt"), "utf8")).toBe("written\n");
    expect(() => readFileSync(path.join(context, "attempt.txt"))).toThrow();

    // Removed at run end (`--rm`), and teardown afterwards is a no-op that still succeeds.
    const gone = await waitGone(runId);
    expect(gone).toBe(true);
    await env.teardown({ runId });
    expect(await runtime.inspect(containerName(runId))).toBeNull();
    expect(await runtime.inspect(probeContainerName(runId))).toBeNull();
    const steps = events.filter((e) => e.payload.run_id === runId).map((e) => e.payload.step);
    expect(steps).toEqual(["image_checked", "prepared"]);
  }, 180_000);

  it("teardown removes a still-running container and the supervised client exits", async () => {
    const runId = newRunId();
    const prepared = await env.prepare(run(runId), invocation("echo READY; sleep 300"));
    const sup = supervise({
      argv: prepared.invocation.argv,
      envAllowlist: prepared.invocation.envAllowlist,
      extraEnv: prepared.invocation.env,
      wallClockMs: 90_000,
      idleMs: 60_000,
      killGraceMs: 2_000,
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await runtime.inspect(containerName(runId)))?.running) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await runtime.inspect(containerName(runId)))?.running).toBe(true);
    await env.teardown({ runId });
    expect(await runtime.inspect(containerName(runId))).toBeNull();
    const result = await Promise.race([sup.result, new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
    if (result === null) await sup.cancel();
    expect(result).not.toBeNull();
    expect(events.some((e) => e.payload.run_id === runId && e.payload.step === "removed")).toBe(true);
  }, 180_000);

  it("an image with git on its PATH starts no run (ADR-0020), and leaves no container behind", async () => {
    // A local derivative of the base image with a fake `git` executable on PATH; nothing is pulled or pushed.
    const tmpName = `sb-t101-gitimage-${newRunId()}`;
    gitImageTag = `switchboard-t101-gitimage:${newRunId().toLowerCase()}`;
    const mk = await docker([
      "run",
      "--name",
      tmpName,
      "--network",
      "none",
      "--user",
      "0:0",
      "--entrypoint",
      "sh",
      baseImageId,
      "-c",
      'printf "#!/bin/sh\\nexit 0\\n" > /usr/local/bin/git && chmod 755 /usr/local/bin/git',
    ]);
    expect(mk.code).toBe(0);
    expect((await docker(["commit", tmpName, gitImageTag])).code).toBe(0);
    await docker(["rm", "--force", tmpName]);
    const gitImageId = (await docker(["image", "inspect", "--format", "{{.Id}}", gitImageTag])).stdout.trim();
    expect(gitImageId).toMatch(/^sha256:/);

    const runId = newRunId();
    let refusal: EnvironmentRefusal | undefined;
    try {
      await env.prepare(run(runId, { imageDigest: gitImageId }), invocation("echo never"));
    } catch (err) {
      if (err instanceof EnvironmentRefusal) refusal = err;
      else throw err;
    }
    expect(refusal?.reason).toBe("CONTAINER_IMAGE_HAS_GIT_CLIENT");
    expect(refusal?.message).toContain("git at /usr/local/bin/git");
    const ps = await docker([
      "ps",
      "--all",
      "--filter",
      `label=${SWITCHBOARD_RUN_LABEL}=${runId}`,
      "--format",
      "{{.Names}}",
    ]);
    expect(ps.stdout.trim()).toBe("");
    expect(await runtime.inspect(containerName(runId))).toBeNull();
    expect(await runtime.inspect(probeContainerName(runId))).toBeNull();
  }, 180_000);

  it("an image that is not present locally is refused without a pull", async () => {
    const runId = newRunId();
    await expect(
      env.prepare(run(runId, { imageDigest: `sha256:${"f".repeat(64)}` }), invocation("true")),
    ).rejects.toMatchObject({ reason: "CONTAINER_IMAGE_NOT_PRESENT" });
  }, 60_000);

  async function waitGone(runId: string): Promise<boolean> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await runtime.inspect(containerName(runId))) === null) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }
});
