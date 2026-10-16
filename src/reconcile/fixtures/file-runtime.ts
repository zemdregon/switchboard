/**
 * A container runtime whose "containers" are JSON files in a directory (T10.2 fault injection). It survives a SIGKILL of
 * the controller that used it, so a restarted controller (another process) sees what was left behind, as with a real
 * runtime. `runArgv` records the container and returns the provider's own argv, with `node` mapped back to this Node
 * executable, so the run spawns a real process without any container runtime. Test-only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContainerRuntime } from "../../environment/index.js";

export const FILE_RUNTIME_IMAGE_ID = `sha256:${"c".repeat(64)}`;

export interface FileRuntimeOptions {
  /** Throw from `listByLabel` (the runtime cannot list its containers). */
  readonly listFails?: boolean;
  /** Called at each `remove`, before the file is deleted (ordering checks). */
  readonly onRemove?: (name: string) => void;
}

export function fileRuntime(dir: string, opts: FileRuntimeOptions = {}): ContainerRuntime {
  mkdirSync(dir, { recursive: true });
  const file = (name: string) => path.join(dir, `${name}.json`);
  return {
    name: "file",
    clientEnvAllowlist: [],
    info: () =>
      Promise.resolve({ available: true, rootless: true, serverVersion: "file", clientPath: null, detail: "file" }),
    resolveImage: () => Promise.resolve({ kind: "found", imageId: FILE_RUNTIME_IMAGE_ID }),
    scanImageForGitClient: () =>
      Promise.resolve({ completed: true, found: [], detail: "no git or gh executable on the image PATH" }),
    runArgv: (spec) => {
      writeFileSync(file(spec.name), JSON.stringify({ name: spec.name, labels: spec.labels }));
      const [exe = "", ...rest] = spec.argv;
      return [exe === path.basename(process.execPath) ? process.execPath : exe, ...rest];
    },
    inspect: () => Promise.resolve(null),
    remove: (name) => {
      opts.onRemove?.(name);
      const was = existsSync(file(name));
      rmSync(file(name), { force: true });
      return Promise.resolve({ removed: was });
    },
    listByLabel: (label) => {
      if (opts.listFails) return Promise.reject(new Error("file runtime: cannot list containers"));
      return Promise.resolve(
        readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map(
            (f) =>
              JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { name: string; labels: Record<string, string> },
          )
          .filter((c) => c.labels[label] !== undefined),
      );
    },
  };
}

/** Plants a labelled "container" as a previous controller would have left it. */
export function plantContainer(dir: string, name: string, labels: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name, labels }));
}
