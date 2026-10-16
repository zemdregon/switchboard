/** The Docker CLI driver over a scripted `exec` (T10.1, ADR-0052). The real client is never run here. */
import { describe, expect, it } from "vitest";
import { createDockerRuntime, DOCKER_CLIENT_ENV, type DockerExec, GIT_CLIENT_SCAN_SCRIPT } from "./docker-runtime.js";
import { ContainerRuntimeError } from "./runtime.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"c".repeat(64)}`;

function scripted(answers: Record<string, { code: number | null; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const exec: DockerExec = (args) => {
    calls.push([...args]);
    const key = args.slice(0, 2).join(" ");
    const a = answers[key] ?? answers[args[0] as string] ?? { code: 1, stderr: `unscripted: ${key}` };
    return Promise.resolve({ code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" });
  };
  return { exec, calls };
}

describe("createDockerRuntime", () => {
  it("info: rootless from the daemon's security options; unavailable when the client is missing or info fails", async () => {
    const s = scripted({ info: { code: 0, stdout: '29.8.2\t["name=seccomp,profile=builtin","name=rootless"]\n' } });
    const rt = createDockerRuntime({ exec: s.exec, clientPath: "/usr/bin/docker" });
    expect(await rt.info()).toEqual({
      available: true,
      rootless: true,
      serverVersion: "29.8.2",
      clientPath: "/usr/bin/docker",
      detail: "docker 29.8.2 at /usr/bin/docker, rootless",
    });
    expect(s.calls[0]).toEqual(["info", "--format", "{{.ServerVersion}}\t{{json .SecurityOptions}}"]);

    const rootful = scripted({ info: { code: 0, stdout: '28.0.0\t["name=seccomp,profile=builtin"]\n' } });
    expect(await createDockerRuntime({ exec: rootful.exec, clientPath: "/usr/bin/docker" }).info()).toMatchObject({
      available: true,
      rootless: false,
    });

    const down = scripted({ info: { code: 1, stderr: "Cannot connect to the Docker daemon" } });
    expect(await createDockerRuntime({ exec: down.exec, clientPath: "/usr/bin/docker" }).info()).toMatchObject({
      available: false,
      rootless: false,
      detail: expect.stringContaining("Cannot connect"),
    });

    const none = createDockerRuntime({ exec: s.exec, clientPath: null });
    expect(await none.info()).toMatchObject({ available: false, clientPath: null, detail: "docker not found on PATH" });
    expect(() => none.runArgv).not.toThrow();
  });

  it("resolveImage matches the image id or a repo digest among local images and never pulls", async () => {
    const s = scripted({
      image: {
        code: 0,
        stdout: [`sha256:${"b".repeat(64)}\t${DIGEST}`, `${OTHER}\t<none>`, `${DIGEST}\t<none>`, ""].join("\n"),
      },
    });
    const rt = createDockerRuntime({ exec: s.exec, clientPath: "/usr/bin/docker" });
    // Two different ids match (one by repo digest, one by id): ambiguous, refused upstream.
    expect(await rt.resolveImage(DIGEST)).toEqual({
      kind: "ambiguous",
      imageIds: [`sha256:${"b".repeat(64)}`, DIGEST],
    });
    expect(await rt.resolveImage(OTHER)).toEqual({ kind: "found", imageId: OTHER });
    expect(await rt.resolveImage(`sha256:${"d".repeat(64)}`)).toEqual({ kind: "not_present" });
    expect(s.calls.every((c) => c[0] === "image" && c[1] === "ls")).toBe(true);
    const failing = scripted({ image: { code: 1, stderr: "permission denied" } });
    await expect(
      createDockerRuntime({ exec: failing.exec, clientPath: "/x" }).resolveImage(DIGEST),
    ).rejects.toBeInstanceOf(ContainerRuntimeError);
  });

  it("scanImageForGitClient runs the PATH scan with no network and a read-only root, and parses FOUND lines", async () => {
    const s = scripted({
      run: {
        code: 0,
        stdout: "FOUND git /usr/bin/git\nFOUND gh /usr/local/bin/gh\nFOUND git /usr/bin/git\nSCAN_DONE 1\n",
      },
    });
    const rt = createDockerRuntime({ exec: s.exec, clientPath: "/usr/bin/docker" });
    const scan = await rt.scanImageForGitClient("sha256:img", "switchboard-probe-R", { "switchboard.run": "R" });
    expect(scan.completed).toBe(true);
    expect(scan.found).toEqual([
      { name: "git", path: "/usr/bin/git" },
      { name: "gh", path: "/usr/local/bin/gh" },
    ]);
    const args = s.calls[0] as string[];
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args).toContain("--read-only");
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(args).toContain("switchboard.run=R");
    expect(args.slice(-4)).toEqual(["sh", "sha256:img", "-c", GIT_CLIENT_SCAN_SCRIPT]);
    expect(args).not.toContain("-e");
    expect(args).not.toContain("-i");
  });

  it("a scan without the end marker, a non-zero exit, or no completion is not clean", async () => {
    const noMarker = scripted({ run: { code: 0, stdout: "" } });
    expect(
      (await createDockerRuntime({ exec: noMarker.exec, clientPath: "/d" }).scanImageForGitClient("i", "p", {}))
        .completed,
    ).toBe(false);
    const noSh = scripted({ run: { code: 127, stderr: 'exec: "sh": executable file not found in $PATH' } });
    const r = await createDockerRuntime({ exec: noSh.exec, clientPath: "/d" }).scanImageForGitClient("i", "p", {});
    expect(r.completed).toBe(false);
    expect(r.detail).toContain("sh");
    const killed = scripted({ run: { code: null }, rm: { code: 0 } });
    const k = await createDockerRuntime({ exec: killed.exec, clientPath: "/d" }).scanImageForGitClient(
      "i",
      "probe-x",
      {},
    );
    expect(k.completed).toBe(false);
    // The probe container may survive a killed client: it is force-removed by name.
    expect(killed.calls.at(-1)).toEqual(["rm", "--force", "probe-x"]);
  });

  it("runArgv uses long flags only, mounts exactly the given set, and puts the provider arguments last", () => {
    const rt = createDockerRuntime({ exec: scripted({}).exec, clientPath: "/usr/bin/docker" });
    const argv = rt.runArgv({
      name: "switchboard-run-R",
      imageId: "sha256:img",
      labels: { "switchboard.run": "R", "switchboard.project": "web" },
      mounts: [
        { source: "/srv/wt", target: "/srv/wt", readonly: false },
        { source: "/srv/docs", target: "/srv/docs", readonly: true },
      ],
      network: "none",
      cpus: 2,
      memoryMb: 1024,
      pidsLimit: 256,
      workdir: "/srv/wt",
      forwardEnv: ["LANG", "SWITCHBOARD_TOOL_TOKEN"],
      argv: ["claude", "-p", "--safe-mode"],
    });
    expect(argv[0]).toBe("/usr/bin/docker");
    expect(argv.slice(1, 3)).toEqual(["run", "--rm"]);
    expect(argv.slice(-3)).toEqual(["claude", "-p", "--safe-mode"]);
    expect(argv.indexOf("sha256:img")).toBe(argv.length - 4);
    const pairs = (flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
    expect(pairs("--mount")).toEqual([
      "type=bind,src=/srv/wt,dst=/srv/wt",
      "type=bind,src=/srv/docs,dst=/srv/docs,readonly",
    ]);
    expect(pairs("--env")).toEqual(["LANG", "SWITCHBOARD_TOOL_TOKEN"]);
    expect(pairs("--label")).toEqual(["switchboard.run=R", "switchboard.project=web"]);
    expect(pairs("--network")).toEqual(["none"]);
    expect(pairs("--cpus")).toEqual(["2"]);
    expect(pairs("--memory")).toEqual(["1024m"]);
    expect(pairs("--memory-swap")).toEqual(["1024m"]);
    expect(pairs("--pids-limit")).toEqual(["256"]);
    expect(pairs("--workdir")).toEqual(["/srv/wt"]);
    expect(pairs("--user")).toEqual(["0:0"]);
    expect(pairs("--cap-drop")).toEqual(["ALL"]);
    expect(pairs("--security-opt")).toEqual(["no-new-privileges"]);
    expect(argv).toContain("--init");
    expect(argv).toContain("--interactive");
    // Short spellings that are bypass-class for some provider never appear (src/adapters/providers.ts).
    for (const short of ["-e", "-i", "-w", "-f", "-H", "-y"]) expect(argv).not.toContain(short);
    expect(argv).not.toContain("--privileged");
    expect(argv.some((a) => a.includes("docker.sock"))).toBe(false);
    // Default network: no --network flag at all (the runtime's default), never a named host network.
    const open = rt.runArgv({
      name: "n",
      imageId: "i",
      labels: {},
      mounts: [],
      network: "default",
      pidsLimit: 1,
      workdir: "/w",
      forwardEnv: [],
      argv: ["x"],
    });
    expect(open).not.toContain("--network");
    expect(open).not.toContain("--cpus");
    expect(open).not.toContain("--memory");
  });

  it("inspect parses mounts, labels, network and privileged; a missing container is null", async () => {
    const raw = {
      Id: "abc",
      State: { Running: true },
      HostConfig: { Privileged: false, NetworkMode: "none" },
      Config: { Labels: { "switchboard.run": "R" } },
      Mounts: [
        { Type: "bind", Source: "/srv/wt", Destination: "/srv/wt", RW: true },
        { Type: "bind", Source: "/srv/docs", Destination: "/srv/docs", RW: false },
      ],
    };
    const s = scripted({ inspect: { code: 0, stdout: JSON.stringify(raw) } });
    const rt = createDockerRuntime({ exec: s.exec, clientPath: "/d" });
    expect(await rt.inspect("switchboard-run-R")).toEqual({
      id: "abc",
      running: true,
      privileged: false,
      networkMode: "none",
      labels: { "switchboard.run": "R" },
      mounts: [
        { source: "/srv/wt", target: "/srv/wt", readonly: false },
        { source: "/srv/docs", target: "/srv/docs", readonly: true },
      ],
    });
    const gone = scripted({ inspect: { code: 1, stderr: "Error: No such container: x" } });
    expect(await createDockerRuntime({ exec: gone.exec, clientPath: "/d" }).inspect("x")).toBeNull();
  });

  it("remove is idempotent: gone already is `removed: false`; other failures throw", async () => {
    const ok = scripted({ rm: { code: 0, stdout: "x\n" } });
    expect(await createDockerRuntime({ exec: ok.exec, clientPath: "/d" }).remove("x")).toEqual({ removed: true });
    expect(ok.calls[0]).toEqual(["rm", "--force", "x"]);
    // Docker 29: `rm --force` of a missing container exits 0 and echoes nothing (observed); that is not a removal.
    const silent = scripted({ rm: { code: 0, stdout: "" } });
    expect(await createDockerRuntime({ exec: silent.exec, clientPath: "/d" }).remove("x")).toEqual({ removed: false });
    const gone = scripted({ rm: { code: 1, stderr: "Error response from daemon: No such container: x" } });
    expect(await createDockerRuntime({ exec: gone.exec, clientPath: "/d" }).remove("x")).toEqual({ removed: false });
    const racing = scripted({ rm: { code: 1, stderr: "removal of container x is already in progress" } });
    expect(await createDockerRuntime({ exec: racing.exec, clientPath: "/d" }).remove("x")).toEqual({ removed: false });
    const bad = scripted({ rm: { code: 1, stderr: "permission denied" } });
    await expect(createDockerRuntime({ exec: bad.exec, clientPath: "/d" }).remove("x")).rejects.toBeInstanceOf(
      ContainerRuntimeError,
    );
  });

  it("listByLabel parses names and label pairs", async () => {
    const s = scripted({
      ps: { code: 0, stdout: "switchboard-run-A\tswitchboard.project=web,switchboard.run=A\nother\tk=v\n" },
    });
    const rt = createDockerRuntime({ exec: s.exec, clientPath: "/d" });
    expect(await rt.listByLabel("switchboard.run")).toEqual([
      { name: "switchboard-run-A", labels: { "switchboard.project": "web", "switchboard.run": "A" } },
      { name: "other", labels: { k: "v" } },
    ]);
    expect(s.calls[0]).toContain("label=switchboard.run");
  });

  it("the client environment allowlist names only socket and config variables", () => {
    expect(DOCKER_CLIENT_ENV).toEqual([
      "PATH",
      "HOME",
      "DOCKER_HOST",
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
      "DOCKER_CERT_PATH",
      "DOCKER_TLS_VERIFY",
      "XDG_RUNTIME_DIR",
    ]);
    expect(createDockerRuntime({ exec: scripted({}).exec, clientPath: "/d" }).clientEnvAllowlist).toBe(
      DOCKER_CLIENT_ENV,
    );
  });
});
