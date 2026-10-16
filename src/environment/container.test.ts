/**
 * The `container` environment over a scripted fake runtime (T10.1; FR-PRJ-04, FR-PRJ-05, ADR-0020, ADR-0052). No
 * container runtime is touched here; the Docker leg is `container-docker.test.ts` (opt-in).
 */
import { describe, expect, it } from "vitest";
import type { Invocation, ResolvedProfile } from "../adapters/types.js";
import {
  containerName,
  containerNetworkFor,
  createContainerEnvironment,
  DEFAULT_PIDS_LIMIT,
  forwardedEnvNames,
  mountPlan,
  probeContainerName,
  SWITCHBOARD_PROJECT_LABEL,
  SWITCHBOARD_ROLE_LABEL,
  SWITCHBOARD_RUN_LABEL,
} from "./container.js";
import { hostEnvironment } from "./host.js";
import type {
  ContainerInspection,
  ContainerRunSpec,
  ContainerRuntime,
  ContainerRuntimeInfo,
  GitClientScan,
  ImageResolution,
} from "./runtime.js";
import { ContainerRuntimeError } from "./runtime.js";
import { environmentKindOf, selectEnvironment, snapshotEnvironment } from "./select.js";
import { type EnvironmentEvent, EnvironmentRefusal, type RunContext } from "./types.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const RUN_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

const INV: Invocation = {
  transport: "subprocess-jsonl",
  argv: ["/usr/local/bin/claude", "-p", "--output-format", "stream-json", "--safe-mode"],
  env: { SWITCHBOARD_TOOL_TOKEN: "t" },
  envAllowlist: ["PATH", "HOME", "LANG", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"],
  cwd: "/srv/wt/run1",
  outputFormat: "jsonl",
  timeouts: { wallClockMs: 60_000, idleMs: 30_000, killGraceMs: 500 },
  policyFlags: ["--safe-mode"],
  expectedExitCodes: [0],
  maxLineBytes: 1024,
};

const RUN: RunContext = {
  runId: RUN_ID,
  projectId: "web",
  worktreePath: "/srv/wt/run1",
  readOnlyContexts: [{ id: "docs", path: "/srv/docs" }],
  profile: PROFILE,
  imageDigest: DIGEST,
  limits: { cpus: 1.5, memoryMb: 512, diskMb: 2048 },
};

interface FakeOptions {
  info?: Partial<ContainerRuntimeInfo>;
  image?: ImageResolution;
  scan?: GitClientScan;
  scanThrows?: Error;
  existing?: Record<string, ContainerInspection>;
  removeThrows?: boolean;
}

/** Records every call; answers from `o`. */
function fakeRuntime(o: FakeOptions = {}) {
  const calls: string[] = [];
  const removed: string[] = [];
  let lastSpec: ContainerRunSpec | undefined;
  const info: ContainerRuntimeInfo = {
    available: true,
    rootless: true,
    serverVersion: "29.8.2",
    clientPath: "/usr/bin/docker",
    detail: "docker 29.8.2 at /usr/bin/docker, rootless",
    ...o.info,
  };
  const runtime: ContainerRuntime = {
    name: "fake",
    clientEnvAllowlist: ["PATH", "HOME", "DOCKER_HOST", "XDG_RUNTIME_DIR"],
    info: () => {
      calls.push("info");
      return Promise.resolve(info);
    },
    resolveImage: (digest) => {
      calls.push(`resolve ${digest}`);
      return Promise.resolve(o.image ?? { kind: "found", imageId: IMAGE_ID });
    },
    scanImageForGitClient: (imageId, probeName, labels) => {
      calls.push(`scan ${imageId} ${probeName} ${labels[SWITCHBOARD_ROLE_LABEL]}`);
      if (o.scanThrows) return Promise.reject(o.scanThrows);
      return Promise.resolve(
        o.scan ?? { completed: true, found: [], detail: "no git or gh executable on the image PATH" },
      );
    },
    runArgv: (spec) => {
      calls.push(`runArgv ${spec.name}`);
      lastSpec = spec;
      return ["/usr/bin/docker", "run", "--name", spec.name, spec.imageId, ...spec.argv];
    },
    inspect: (name) => Promise.resolve(o.existing?.[name] ?? null),
    remove: (name) => {
      calls.push(`remove ${name}`);
      if (o.removeThrows) return Promise.reject(new ContainerRuntimeError("docker rm exited 1: daemon gone"));
      const was = o.existing?.[name] !== undefined;
      if (was) {
        removed.push(name);
        delete o.existing?.[name];
      }
      return Promise.resolve({ removed: was });
    },
    listByLabel: (label) => {
      calls.push(`list ${label}`);
      return Promise.resolve(
        Object.entries(o.existing ?? {})
          .filter(([, c]) => c.labels[label] !== undefined)
          .map(([name, c]) => ({ name, labels: c.labels })),
      );
    },
  };
  return { runtime, calls, removed, spec: () => lastSpec };
}

async function refusal(p: Promise<unknown>): Promise<EnvironmentRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EnvironmentRefusal) return err;
    throw err;
  }
  throw new Error("expected an EnvironmentRefusal");
}

describe("hostEnvironment", () => {
  it("is the identity: the invocation is returned unchanged and teardown/sweep do nothing", async () => {
    const prepared = await hostEnvironment.prepare(RUN, INV);
    expect(prepared.invocation).toBe(INV);
    expect(prepared.container).toBeUndefined();
    await expect(hostEnvironment.teardown({ runId: RUN_ID })).resolves.toBeUndefined();
    await expect(hostEnvironment.sweepOrphans(new Set())).resolves.toEqual({ removed: [] });
  });
});

describe("selectEnvironment / environmentKindOf / snapshotEnvironment", () => {
  it("a run without a project, or with a host project, is host; host defaults to the identity implementation", () => {
    expect(environmentKindOf(undefined)).toBe("host");
    expect(environmentKindOf({})).toBe("host");
    expect(environmentKindOf({ project: { environment_kind: "host" } })).toBe("host");
    expect(selectEnvironment("host", undefined)).toBe(hostEnvironment);
  });
  it("a container project selects the registered container environment, and none when none is registered", () => {
    expect(environmentKindOf({ project: { environment_kind: "container" } })).toBe("container");
    expect(selectEnvironment("container", undefined)).toBeUndefined();
    expect(selectEnvironment("container", { host: hostEnvironment })).toBeUndefined();
    const container = createContainerEnvironment({ runtime: fakeRuntime().runtime });
    expect(selectEnvironment("container", { container })).toBe(container);
  });
  it("snapshotEnvironment records the kind, and the digest only for a container project (FR-PRJ-04)", () => {
    expect(snapshotEnvironment({ environment: { kind: "host" } })).toEqual({ environment_kind: "host" });
    expect(snapshotEnvironment({ environment: { kind: "container", imageDigest: DIGEST } })).toEqual({
      environment_kind: "container",
      image_digest: DIGEST,
    });
  });
});

describe("containerNetworkFor (TDD §3.11, Delegated)", () => {
  const p = (over: Partial<ResolvedProfile>): ResolvedProfile => ({ ...PROFILE, ...over });
  it("off, and an empty allowlist, are network none enforced by the mode itself", () => {
    expect(containerNetworkFor(p({ network: "off" }))).toEqual({ mode: "none", enforcement: "switchboard" });
    expect(containerNetworkFor(p({ network: "allowlist", networkAllowlist: [] }))).toEqual({
      mode: "none",
      enforcement: "switchboard",
    });
  });
  it("a non-empty allowlist is refused: the runtime cannot enforce a host allowlist (fail closed)", () => {
    const r = containerNetworkFor(p({ network: "allowlist", networkAllowlist: ["example.com"] }));
    expect(r).toHaveProperty("refused");
    expect((r as { refused: string }).refused).toMatch(/cannot enforce a host allowlist/);
  });
  it("policy means the provider's own policy decides, recorded as such on the default network", () => {
    expect(containerNetworkFor(p({ network: "policy" }))).toEqual({ mode: "default", enforcement: "provider_policy" });
  });
  it("scoped follows the approved scope: off -> none, on -> default, hosts -> refused, no scope -> refused", () => {
    const scoped = (network: { mode: "off" } | { mode: "on" } | { mode: "allowlist"; hosts: string[] }) =>
      p({
        name: "privileged",
        network: "scoped",
        privilegedScope: {
          scope: {
            files: { mode: "worktree" },
            shell: { mode: "none" },
            network,
            repository_config: { mode: "disabled" },
            bypass: true,
          },
          scopeHash: "h",
          approvalId: "a",
        } as unknown as NonNullable<ResolvedProfile["privilegedScope"]>,
      });
    expect(containerNetworkFor(scoped({ mode: "off" }))).toEqual({ mode: "none", enforcement: "switchboard" });
    expect(containerNetworkFor(scoped({ mode: "on" }))).toEqual({ mode: "default", enforcement: "switchboard" });
    expect(containerNetworkFor(scoped({ mode: "allowlist", hosts: ["a.example"] }))).toHaveProperty("refused");
    expect(containerNetworkFor(p({ network: "scoped" }))).toHaveProperty("refused");
  });
});

describe("mountPlan and forwardedEnvNames (FR-PRJ-05, FR-EXE-07)", () => {
  it("mounts the worktree writable and each context read-only, at their own paths, and nothing else", () => {
    expect(mountPlan(RUN)).toEqual([
      { source: "/srv/wt/run1", target: "/srv/wt/run1", readonly: false },
      { source: "/srv/docs", target: "/srv/docs", readonly: true },
    ]);
  });
  it("refuses relative, unnormalised, comma-bearing, duplicate and nested paths", () => {
    const with_ = (contexts: RunContext["readOnlyContexts"], worktreePath = RUN.worktreePath) =>
      mountPlan({ ...RUN, worktreePath, readOnlyContexts: contexts });
    expect(with_([{ id: "r", path: "relative/ctx" }])).toHaveProperty("invalid");
    expect(with_([{ id: "r", path: "/srv/docs/" }])).toHaveProperty("invalid");
    expect(with_([{ id: "r", path: "/srv/a,b" }])).toHaveProperty("invalid");
    expect(with_([{ id: "r", path: "/srv/wt/run1" }])).toHaveProperty("invalid");
    expect(with_([{ id: "r", path: "/srv/wt/run1/sub" }])).toHaveProperty("invalid");
    expect(with_([{ id: "r", path: "/srv" }])).toHaveProperty("invalid");
    expect(with_([{ id: "r", path: "/srv/wt/run10" }])).toEqual([
      { source: "/srv/wt/run1", target: "/srv/wt/run1", readonly: false },
      { source: "/srv/wt/run10", target: "/srv/wt/run10", readonly: true },
    ]);
  });
  it("forwards allowlisted names minus host-only ones, plus adapter variables; values are never involved", () => {
    expect(forwardedEnvNames(INV)).toEqual(["LANG", "CLAUDE_CONFIG_DIR", "SWITCHBOARD_TOOL_TOKEN"]);
    expect(
      forwardedEnvNames({ envAllowlist: ["HOME", "SSH_AUTH_SOCK", "DOCKER_HOST", "XDG_RUNTIME_DIR"], env: {} }),
    ).toEqual([]);
  });
});

describe("createContainerEnvironment.prepare", () => {
  it("wraps the invocation in a runtime run with the same cwd path inside, labels, limits and the checked image", async () => {
    const fake = fakeRuntime();
    const events: EnvironmentEvent[] = [];
    const env = createContainerEnvironment({ runtime: fake.runtime, onEvent: (e) => events.push(e) });
    const prepared = await env.prepare(RUN, INV);

    expect(fake.calls).toEqual([
      "info",
      `resolve ${DIGEST}`,
      `scan ${IMAGE_ID} ${probeContainerName(RUN_ID)} probe`,
      `runArgv ${containerName(RUN_ID)}`,
    ]);
    const spec = fake.spec();
    expect(spec).toMatchObject({
      name: containerName(RUN_ID),
      imageId: IMAGE_ID,
      labels: { [SWITCHBOARD_RUN_LABEL]: RUN_ID, [SWITCHBOARD_PROJECT_LABEL]: "web", [SWITCHBOARD_ROLE_LABEL]: "run" },
      mounts: [
        { source: "/srv/wt/run1", target: "/srv/wt/run1", readonly: false },
        { source: "/srv/docs", target: "/srv/docs", readonly: true },
      ],
      network: "none",
      cpus: 1.5,
      memoryMb: 512,
      pidsLimit: DEFAULT_PIDS_LIMIT,
      workdir: "/srv/wt/run1",
      forwardEnv: ["LANG", "CLAUDE_CONFIG_DIR", "SWITCHBOARD_TOOL_TOKEN"],
      // argv[0] becomes the executable name the image's PATH resolves; every provider flag follows unchanged.
      argv: ["claude", "-p", "--output-format", "stream-json", "--safe-mode"],
    });
    // The prepared invocation keeps everything the audits and the supervisor rely on except argv and the allowlist.
    expect(prepared.invocation.argv).toEqual([
      "/usr/bin/docker",
      "run",
      "--name",
      containerName(RUN_ID),
      IMAGE_ID,
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--safe-mode",
    ]);
    expect(prepared.invocation.envAllowlist).toEqual([
      "PATH",
      "HOME",
      "DOCKER_HOST",
      "XDG_RUNTIME_DIR",
      "LANG",
      "XDG_CONFIG_HOME",
      "CLAUDE_CONFIG_DIR",
    ]);
    expect(prepared.invocation.env).toEqual(INV.env);
    expect(prepared.invocation.cwd).toBe(INV.cwd);
    expect(prepared.invocation.policyFlags).toEqual(INV.policyFlags);
    expect(prepared.invocation.timeouts).toEqual(INV.timeouts);
    expect(prepared.container).toMatchObject({
      name: containerName(RUN_ID),
      imageId: IMAGE_ID,
      network: { mode: "none", enforcement: "switchboard" },
      limits: { cpus: 1.5, memoryMb: 512, pidsLimit: DEFAULT_PIDS_LIMIT, diskMbNotEnforced: 2048 },
      executable: "claude",
      forwardedEnv: ["LANG", "CLAUDE_CONFIG_DIR", "SWITCHBOARD_TOOL_TOKEN"],
    });
    expect(events.map((e) => e.payload.step)).toEqual(["image_checked", "prepared"]);
    const text = JSON.stringify(events);
    expect(text).not.toContain('"t"'); // no env value in any event
    expect(events[1]?.payload).toMatchObject({
      container: containerName(RUN_ID),
      network: "none",
      network_enforcement: "switchboard",
      mounts: [
        { target: "/srv/wt/run1", readonly: false },
        { target: "/srv/docs", readonly: true },
      ],
    });
  });

  it("refuses an image with git or gh on its PATH before any run, naming the executable (ADR-0020)", async () => {
    const fake = fakeRuntime({
      scan: { completed: true, found: [{ name: "gh", path: "/usr/bin/gh" }], detail: "found gh at /usr/bin/gh" },
    });
    const events: EnvironmentEvent[] = [];
    const env = createContainerEnvironment({ runtime: fake.runtime, onEvent: (e) => events.push(e) });
    const err = await refusal(env.prepare(RUN, INV));
    expect(err.reason).toBe("CONTAINER_IMAGE_HAS_GIT_CLIENT");
    expect(err.message).toContain("gh at /usr/bin/gh");
    expect(fake.calls.some((c) => c.startsWith("runArgv"))).toBe(false);
    expect(events.map((e) => e.payload.step)).toEqual(["refused"]);
    expect(events[0]?.payload.reason).toBe("CONTAINER_IMAGE_HAS_GIT_CLIENT");
  });

  it("refuses when the scan could not complete, and when the runtime command fails (fail closed)", async () => {
    const incomplete = fakeRuntime({ scan: { completed: false, found: [], detail: "scan exited 127: sh not found" } });
    const env1 = createContainerEnvironment({ runtime: incomplete.runtime });
    expect((await refusal(env1.prepare(RUN, INV))).reason).toBe("CONTAINER_IMAGE_CHECK_FAILED");
    const throwing = fakeRuntime({ scanThrows: new ContainerRuntimeError("docker image ls exited 1: cannot connect") });
    const env2 = createContainerEnvironment({ runtime: throwing.runtime });
    const err = await refusal(env2.prepare(RUN, INV));
    expect(err.reason).toBe("CONTAINER_IMAGE_CHECK_FAILED");
    expect(err.message).toContain("cannot connect");
  });

  it("refuses a missing or ambiguous image; nothing is ever pulled", async () => {
    const missing = createContainerEnvironment({ runtime: fakeRuntime({ image: { kind: "not_present" } }).runtime });
    const e1 = await refusal(missing.prepare(RUN, INV));
    expect(e1.reason).toBe("CONTAINER_IMAGE_NOT_PRESENT");
    expect(e1.message).toContain("never pulls");
    const ambiguous = createContainerEnvironment({
      runtime: fakeRuntime({ image: { kind: "ambiguous", imageIds: ["sha256:1", "sha256:2"] } }).runtime,
    });
    expect((await refusal(ambiguous.prepare(RUN, INV))).reason).toBe("CONTAINER_IMAGE_AMBIGUOUS");
  });

  it("refuses an unavailable or non-rootless runtime before resolving anything", async () => {
    const down = fakeRuntime({ info: { available: false, detail: "docker info exited 1: cannot connect" } });
    const e1 = await refusal(createContainerEnvironment({ runtime: down.runtime }).prepare(RUN, INV));
    expect(e1.reason).toBe("CONTAINER_RUNTIME_UNAVAILABLE");
    expect(down.calls).toEqual(["info"]);
    const rootful = fakeRuntime({ info: { rootless: false, detail: "docker 29 at /usr/bin/docker, not rootless" } });
    const e2 = await refusal(createContainerEnvironment({ runtime: rootful.runtime }).prepare(RUN, INV));
    expect(e2.reason).toBe("CONTAINER_RUNTIME_UNAVAILABLE");
    expect(e2.message).toContain("rootless");
    expect(rootful.calls).toEqual(["info"]);
  });

  it("refuses a run without a project or without a pinned digest, and a profile whose network it cannot enforce", async () => {
    const env = createContainerEnvironment({ runtime: fakeRuntime().runtime });
    const { projectId: _p, ...noProject } = RUN;
    expect((await refusal(env.prepare(noProject, INV))).reason).toBe("CONTAINER_PROJECT_REQUIRED");
    const { imageDigest: _d, ...noDigest } = RUN;
    expect((await refusal(env.prepare(noDigest, INV))).reason).toBe("CONTAINER_IMAGE_NOT_PINNED");
    const allowlist = {
      ...RUN,
      profile: { ...PROFILE, network: "allowlist" as const, networkAllowlist: ["x.example"] },
    };
    expect((await refusal(env.prepare(allowlist, INV))).reason).toBe("CONTAINER_NETWORK_UNENFORCEABLE");
    const nested = { ...RUN, readOnlyContexts: [{ id: "n", path: "/srv/wt/run1/docs" }] };
    expect((await refusal(env.prepare(nested, INV))).reason).toBe("CONTAINER_MOUNT_PATH_INVALID");
  });

  it("a policy profile runs on the default network with the enforcement recorded as the provider's", async () => {
    const fake = fakeRuntime();
    const env = createContainerEnvironment({ runtime: fake.runtime });
    const prepared = await env.prepare({ ...RUN, profile: { ...PROFILE, network: "policy" } }, INV);
    expect(fake.spec()?.network).toBe("default");
    expect(prepared.container?.network).toEqual({ mode: "default", enforcement: "provider_policy" });
  });
});

describe("createContainerEnvironment.teardown and sweepOrphans", () => {
  const container = (runId: string, role = "run"): ContainerInspection => ({
    id: `id-${runId}`,
    running: false,
    privileged: false,
    networkMode: "none",
    labels: { [SWITCHBOARD_RUN_LABEL]: runId, [SWITCHBOARD_PROJECT_LABEL]: "web", [SWITCHBOARD_ROLE_LABEL]: role },
    mounts: [],
  });

  it("removes the run container and the probe, is idempotent, and never throws", async () => {
    const fake = fakeRuntime({
      existing: {
        [containerName(RUN_ID)]: container(RUN_ID),
        [probeContainerName(RUN_ID)]: container(RUN_ID, "probe"),
      },
    });
    const events: EnvironmentEvent[] = [];
    const env = createContainerEnvironment({ runtime: fake.runtime, onEvent: (e) => events.push(e) });
    await env.teardown({ runId: RUN_ID });
    expect(fake.removed).toEqual([containerName(RUN_ID), probeContainerName(RUN_ID)]);
    expect(events.map((e) => e.payload.step)).toEqual(["removed", "removed"]);
    await env.teardown({ runId: RUN_ID });
    expect(fake.removed).toHaveLength(2);
    expect(events).toHaveLength(2); // already gone: no second `removed`
  });

  it("a failing remove is reported as remove_failed, not thrown", async () => {
    const fake = fakeRuntime({ removeThrows: true });
    const events: EnvironmentEvent[] = [];
    const env = createContainerEnvironment({ runtime: fake.runtime, onEvent: (e) => events.push(e) });
    await expect(env.teardown({ runId: RUN_ID })).resolves.toBeUndefined();
    expect(events.map((e) => e.payload.step)).toEqual(["remove_failed", "remove_failed"]);
    expect(events[0]?.payload.detail).toContain("daemon gone");
  });

  it("sweepOrphans removes labelled containers of unknown runs and keeps those of known runs", async () => {
    const fake = fakeRuntime({
      existing: {
        [containerName("LIVE")]: container("LIVE"),
        [containerName("GONE")]: container("GONE"),
        [probeContainerName("GONE")]: container("GONE", "probe"),
        unrelated: { ...container("x"), labels: { other: "y" } },
      },
    });
    const events: EnvironmentEvent[] = [];
    const env = createContainerEnvironment({ runtime: fake.runtime, onEvent: (e) => events.push(e) });
    const r = await env.sweepOrphans(new Set(["LIVE"]));
    expect(r.removed.sort()).toEqual([containerName("GONE"), probeContainerName("GONE")].sort());
    expect(fake.removed).not.toContain(containerName("LIVE"));
    expect(fake.removed).not.toContain("unrelated");
    expect(events.every((e) => e.payload.step === "orphan_removed" && e.payload.run_id === "GONE")).toBe(true);
  });
});
