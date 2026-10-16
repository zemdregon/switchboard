/**
 * Docker CLI driver for the container-runtime port (ADR-0052; T10.1). Observed against rootless Docker Engine 29.8.2 on
 * the Ampere operator host ([spike](../../docs/research/container-runtime-spike-2026-10-16.md)); CI runners without a
 * rootless daemon see `available: false` and the opt-in tests skip.
 *
 * Delegated choices:
 * - The client is run with `execFile` and an environment of only {@link DOCKER_CLIENT_ENV} (socket and config location),
 *   never through a shell. Nothing is pulled: `resolveImage` reads `docker image ls` and matches the image id or a repo
 *   digest.
 * - Long flag spellings only (`--env`, `--interactive`, `--workdir`): `-e` and `-w` are bypass-class short flags of a
 *   provider (`src/adapters/providers.ts`), and the lifecycle's audit scans the whole argv.
 * - `rootless` is read from `docker info`'s security options; the environment refuses anything else (TDD §3.11).
 */
import { execFile } from "node:child_process";
import { findOnPath } from "../exec/outer-sandbox.js";
import {
  type ContainerInspection,
  type ContainerRunSpec,
  type ContainerRuntime,
  ContainerRuntimeError,
  type ContainerRuntimeInfo,
  type GitClientScan,
  type ImageResolution,
} from "./runtime.js";
import type { ContainerMount } from "./types.js";

/** What the `docker` client needs from the environment to find a rootless daemon and its config; nothing else. */
export const DOCKER_CLIENT_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "XDG_RUNTIME_DIR",
];

export interface DockerExecResult {
  /** Exit code, or null when the client could not be started, was killed or timed out. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type DockerExec = (args: readonly string[], opts: { readonly timeoutMs: number }) => Promise<DockerExecResult>;

export interface DockerRuntimeDeps {
  /** Source of {@link DOCKER_CLIENT_ENV}; defaults to `process.env`. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Runs one client command. Defaults to `execFile` on the client found on `PATH`. Tests script this. */
  readonly exec?: DockerExec;
  /** Absolute client path; defaults to the first `docker` on `baseEnv.PATH`. */
  readonly clientPath?: string | null;
}

/** Bounds (Assumptions): the daemon answers `info` in well under this; a `PATH` scan of a slim image takes seconds. */
export const DOCKER_INFO_TIMEOUT_MS = 15_000;
export const DOCKER_SCAN_TIMEOUT_MS = 60_000;
export const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * ADR-0020 item 2 as a POSIX `sh` script: every directory of the image's `PATH` is checked for an executable regular
 * file named `git` or `gh`, then `command -v` once more for each. The end marker proves the scan ran to completion.
 */
export const GIT_CLIENT_SCAN_SCRIPT = [
  "found=0",
  'IFS=":"',
  "for d in $PATH; do",
  "  for n in git gh; do",
  '    if [ -f "$d/$n" ] && [ -x "$d/$n" ]; then echo "FOUND $n $d/$n"; found=1; fi',
  "  done",
  "done",
  "for n in git gh; do",
  '  p=$(command -v "$n" 2>/dev/null) && echo "FOUND $n $p" && found=1',
  "done",
  'echo "SCAN_DONE $found"',
].join("\n");
export const GIT_CLIENT_SCAN_DONE = "SCAN_DONE";

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 300);

function defaultExec(clientPath: string, env: Readonly<Record<string, string>>): DockerExec {
  return (args, opts) =>
    new Promise((resolve) => {
      try {
        execFile(
          clientPath,
          [...args],
          { env, timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, encoding: "utf8" },
          (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" && !err.killed ? err.code : null) : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      } catch (err) {
        resolve({ code: null, stdout: "", stderr: (err as Error).message });
      }
    });
}

/** `k=v` pairs for `--label`; keys and values are controller-chosen (run id, project id), never free text. */
function labelArgs(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
}

/** `--mount` CSV syntax; the environment has already refused paths that would break it (commas). */
function mountArg(m: ContainerMount): string {
  return `type=bind,src=${m.source},dst=${m.target}${m.readonly ? ",readonly" : ""}`;
}

const SECURITY_ARGS: readonly string[] = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"];

export function createDockerRuntime(deps: DockerRuntimeDeps = {}): ContainerRuntime {
  const baseEnv = deps.baseEnv ?? process.env;
  const clientPath = deps.clientPath !== undefined ? deps.clientPath : findOnPath("docker", baseEnv.PATH);
  const clientEnv: Record<string, string> = {};
  for (const name of DOCKER_CLIENT_ENV) {
    const v = baseEnv[name];
    if (v !== undefined) clientEnv[name] = v;
  }
  const exec: DockerExec =
    deps.exec ??
    (clientPath !== null
      ? defaultExec(clientPath, clientEnv)
      : () => Promise.resolve({ code: null, stdout: "", stderr: "docker not found on PATH" }));

  const fail = (what: string, r: DockerExecResult): never => {
    throw new ContainerRuntimeError(
      `${what} ${r.code === null ? "did not complete (not startable, killed or timed out)" : `exited ${r.code}`}` +
        `${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ""}`,
    );
  };

  const runtime: ContainerRuntime = {
    name: "docker",
    clientEnvAllowlist: DOCKER_CLIENT_ENV,

    async info(): Promise<ContainerRuntimeInfo> {
      if (clientPath === null) {
        return {
          available: false,
          rootless: false,
          serverVersion: null,
          clientPath,
          detail: "docker not found on PATH",
        };
      }
      const r = await exec(["info", "--format", "{{.ServerVersion}}\t{{json .SecurityOptions}}"], {
        timeoutMs: DOCKER_INFO_TIMEOUT_MS,
      });
      if (r.code !== 0) {
        const why =
          r.code === null ? "docker info did not complete" : `docker info exited ${r.code}: ${firstLine(r.stderr)}`;
        return { available: false, rootless: false, serverVersion: null, clientPath, detail: why };
      }
      const [version = "", optionsJson = "[]"] = firstLine(r.stdout).split("\t");
      let options: unknown;
      try {
        options = JSON.parse(optionsJson);
      } catch {
        options = [];
      }
      const rootless = Array.isArray(options) && options.some((o) => o === "name=rootless");
      const serverVersion = version.trim() === "" ? null : version.trim();
      return {
        available: true,
        rootless,
        serverVersion,
        clientPath,
        detail: `docker ${serverVersion ?? "(unknown version)"} at ${clientPath}, ${rootless ? "rootless" : "not rootless"}`,
      };
    },

    async resolveImage(digest: string): Promise<ImageResolution> {
      const r = await exec(["image", "ls", "--no-trunc", "--digests", "--format", "{{.ID}}\t{{.Digest}}"], {
        timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
      });
      if (r.code !== 0) fail("docker image ls", r);
      const ids = new Set<string>();
      for (const line of r.stdout.split("\n")) {
        const [id = "", repoDigest = ""] = line.trim().split("\t");
        if (id === "") continue;
        if (id === digest || repoDigest === digest) ids.add(id);
      }
      if (ids.size === 0) return { kind: "not_present" };
      if (ids.size > 1) return { kind: "ambiguous", imageIds: [...ids] };
      return { kind: "found", imageId: [...ids][0] as string };
    },

    async scanImageForGitClient(imageId, probeName, labels): Promise<GitClientScan> {
      const args = [
        "run",
        "--rm",
        "--name",
        probeName,
        ...labelArgs(labels),
        "--network",
        "none",
        "--read-only",
        ...SECURITY_ARGS,
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
        imageId,
        "-c",
        GIT_CLIENT_SCAN_SCRIPT,
      ];
      const r = await exec(args, { timeoutMs: DOCKER_SCAN_TIMEOUT_MS });
      if (r.code === null) {
        // Killed or timed out: the probe container may still exist; the environment's teardown removes it by name.
        await runtime.remove(probeName).catch(() => undefined);
      }
      const lines = r.stdout.split("\n").map((l) => l.trim());
      const completed = r.code === 0 && lines.some((l) => l.startsWith(GIT_CLIENT_SCAN_DONE));
      const found = new Map<string, { name: "git" | "gh"; path: string }>();
      for (const l of lines) {
        const m = /^FOUND (git|gh) (\/\S+)$/.exec(l);
        if (m) found.set(m[2] as string, { name: m[1] as "git" | "gh", path: m[2] as string });
      }
      const detail = completed
        ? found.size === 0
          ? "no git or gh executable on the image PATH"
          : `found ${[...found.values()].map((f) => `${f.name} at ${f.path}`).join(", ")}`
        : r.code === null
          ? "scan did not complete (killed or timed out)"
          : `scan exited ${r.code}${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ""}`;
      return { completed, found: [...found.values()], detail };
    },

    runArgv(spec: ContainerRunSpec): readonly string[] {
      if (clientPath === null) throw new ContainerRuntimeError("docker not found on PATH");
      const args: string[] = [
        clientPath,
        "run",
        "--rm",
        "--name",
        spec.name,
        ...labelArgs(spec.labels),
        "--init",
        "--interactive",
        "--user",
        "0:0",
        ...SECURITY_ARGS,
        "--pids-limit",
        String(spec.pidsLimit),
        "--workdir",
        spec.workdir,
      ];
      if (spec.network === "none") args.push("--network", "none");
      if (spec.cpus !== undefined) args.push("--cpus", String(spec.cpus));
      if (spec.memoryMb !== undefined) args.push("--memory", `${spec.memoryMb}m`, "--memory-swap", `${spec.memoryMb}m`);
      for (const m of spec.mounts) args.push("--mount", mountArg(m));
      for (const name of spec.forwardEnv) args.push("--env", name);
      args.push(spec.imageId, ...spec.argv);
      return args;
    },

    async inspect(name: string): Promise<ContainerInspection | null> {
      const r = await exec(["inspect", "--type", "container", "--format", "{{json .}}", name], {
        timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
      });
      if (r.code !== 0) {
        if (r.code !== null && /no such (container|object)/i.test(r.stderr)) return null;
        fail("docker inspect", r);
      }
      let raw: {
        Id?: string;
        State?: { Running?: boolean };
        HostConfig?: { Privileged?: boolean; NetworkMode?: string };
        Config?: { Labels?: Record<string, string> | null };
        Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
      };
      try {
        raw = JSON.parse(r.stdout);
      } catch {
        throw new ContainerRuntimeError("docker inspect returned unparseable output");
      }
      return {
        id: raw.Id ?? "",
        running: raw.State?.Running === true,
        privileged: raw.HostConfig?.Privileged === true,
        networkMode: raw.HostConfig?.NetworkMode ?? "",
        labels: { ...(raw.Config?.Labels ?? {}) },
        mounts: (raw.Mounts ?? []).map((m) => ({
          source: m.Type === "bind" ? (m.Source ?? "") : `${m.Type ?? "unknown"}:${m.Source ?? ""}`,
          target: m.Destination ?? "",
          readonly: m.RW !== true,
        })),
      };
    },

    async remove(name: string): Promise<{ removed: boolean }> {
      const r = await exec(["rm", "--force", name], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS });
      // Observed (Docker 29.8.2): `rm --force` of a missing container exits 0 with empty stdout; a removed one is
      // echoed by name. Older clients exit 1 with "No such container". Only an echoed name counts as removed.
      if (r.code === 0) {
        const echoed = r.stdout.split("\n").map((l) => l.trim());
        return { removed: echoed.includes(name) };
      }
      if (r.code !== null && /no such container|removal of container .* is already in progress/i.test(r.stderr)) {
        return { removed: false };
      }
      return fail("docker rm", r);
    },

    async listByLabel(label: string) {
      const r = await exec(["ps", "--all", "--filter", `label=${label}`, "--format", "{{.Names}}\t{{.Labels}}"], {
        timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
      });
      if (r.code !== 0) fail("docker ps", r);
      const out: Array<{ name: string; labels: Record<string, string> }> = [];
      for (const line of r.stdout.split("\n")) {
        const [name = "", labelText = ""] = line.trim().split("\t");
        if (name === "") continue;
        const labels: Record<string, string> = {};
        for (const pair of labelText.split(",")) {
          const eq = pair.indexOf("=");
          if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        out.push({ name, labels });
      }
      return out;
    },
  };
  return runtime;
}
