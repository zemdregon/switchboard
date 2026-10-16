/**
 * `switchboard projects list|show|validate` (FR-PRJ-08, T9.1). All three read the config and the filesystem and
 * nothing else: no ledger, no lock, no provider process, no run container. `validate` is the only
 * place the filesystem rules run (FR-PRJ-02, FR-POL-10): absolute path, canonical path under an allowed root (the same
 * `realpath` + `isUnderAllowedRoot` check workspaces use, so `..` and symlink escapes land outside), a Git repository
 * whose top level is itself under an allowed root, and a base ref that resolves to a commit.
 *
 * T10.3 (FR-PRJ-05, FR-PRJ-08, ADR-0020): for a `container` project `validate` also checks environment availability
 * with the container runtime: it answers and is rootless, the pinned image is present locally (never pulled), and the
 * image has no `git` or `gh` on its `PATH`, by the same throwaway probe container creation uses (no network, read-only
 * root, removed). It starts no run. T10.1: `serve` now runs container projects through that backend, so a container
 * project whose runtime and image pass these checks validates clean (no `ENVIRONMENT_NOT_IMPLEMENTED`).
 */
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  CONTAINER_NOT_IMPLEMENTED,
  ConfigError,
  isUnderAllowedRoot,
  loadConfig,
  type ResolvedConfig,
  type ResolvedProject,
} from "../config/index.js";
import {
  type ContainerRuntime,
  createDockerRuntime,
  probeContainerName,
  SWITCHBOARD_PROJECT_LABEL,
  SWITCHBOARD_ROLE_LABEL,
} from "../environment/index.js";
import { repoSigningConfigUnsafe, testSignature } from "../git/sign.js";
import { gitText } from "../workspace/git.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";

export class UnknownProjectError extends Error {
  override readonly name = "UnknownProjectError";
}

export { CONTAINER_NOT_IMPLEMENTED };

export interface ProjectFailure {
  /** JSON path into the config file, e.g. `$.projects[0].contexts[0].path`. */
  path: string;
  code: string;
  message: string;
}

export interface ProjectContextView {
  id: string;
  kind: string;
  path: string;
  base_ref: string;
  primary: boolean;
  writable: boolean;
  push: { policy: string; remote?: string; branch_prefix?: string };
  identity?: { name: string; email: string };
  sign: boolean;
  /** T9.7 (FR-GIT-09): finalize-only opt-in. */
  finalize_commit: boolean;
  /** T11.3: present only when the context restricts the inner agent. */
  inner_agent?: string;
}

export interface ProjectView {
  id: string;
  name: string;
  environment: {
    kind: string;
    image_digest?: string;
    limits?: { cpus?: number; memory_mb?: number; disk_mb?: number };
  };
  max_trust_profile?: string;
  allowed_providers?: string[];
  /** T11.3: present only when the project restricts the inner agent. */
  inner_agent?: string;
  contexts: ProjectContextView[];
}

export interface ProjectsValidation {
  schema_version: number;
  ok: boolean;
  projects: { id: string; ok: boolean; failures: ProjectFailure[] }[];
  /** Failures that stop the config loading at all (schema, duplicate ids): no project can be checked then. */
  config_failures: ProjectFailure[];
}

function load(io: CliIo, argv: readonly string[]): ResolvedConfig {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
}

export function toProjectView(p: ResolvedProject): ProjectView {
  return {
    id: p.id,
    name: p.name,
    environment: {
      kind: p.environment.kind,
      ...(p.environment.imageDigest !== undefined ? { image_digest: p.environment.imageDigest } : {}),
      ...(p.environment.limits !== undefined
        ? {
            limits: {
              ...(p.environment.limits.cpus !== undefined ? { cpus: p.environment.limits.cpus } : {}),
              ...(p.environment.limits.memoryMb !== undefined ? { memory_mb: p.environment.limits.memoryMb } : {}),
              ...(p.environment.limits.diskMb !== undefined ? { disk_mb: p.environment.limits.diskMb } : {}),
            },
          }
        : {}),
    },
    ...(p.maxTrustProfile !== undefined ? { max_trust_profile: p.maxTrustProfile } : {}),
    ...(p.allowedProviders !== undefined ? { allowed_providers: [...p.allowedProviders] } : {}),
    ...(p.innerAgent !== undefined ? { inner_agent: p.innerAgent } : {}),
    contexts: p.contexts.map((c) => ({
      id: c.id,
      kind: c.kind,
      path: c.path,
      base_ref: c.baseRef,
      primary: c.primary,
      writable: c.writable,
      push: {
        policy: c.push.policy,
        ...(c.push.remote !== undefined ? { remote: c.push.remote } : {}),
        ...(c.push.branchPrefix !== undefined ? { branch_prefix: c.push.branchPrefix } : {}),
      },
      ...(c.identity !== undefined ? { identity: { ...c.identity } } : {}),
      sign: c.sign,
      finalize_commit: c.finalizeCommit,
      ...(c.innerAgent !== undefined ? { inner_agent: c.innerAgent } : {}),
    })),
  };
}

export function listProjects(io: CliIo, argv: readonly string[]): ProjectView[] {
  return load(io, argv).projects.map(toProjectView);
}

export function showProject(io: CliIo, argv: readonly string[], id: string): ProjectView {
  const p = load(io, argv).projects.find((x) => x.id === id);
  if (!p) throw new UnknownProjectError(`unknown project ${id}`);
  return toProjectView(p);
}

/** Turns a `ConfigError` message (`Invalid ...:` then `  $.path: text` lines) into per-path failures. */
function configFailures(err: ConfigError): ProjectFailure[] {
  const out: ProjectFailure[] = [];
  for (const line of err.message.split("\n").slice(1)) {
    const m = /^\s*(\$[^\s:]*): (.*)$/.exec(line);
    out.push(
      m
        ? { path: m[1] as string, code: "CONFIG_INVALID", message: m[2] as string }
        : { path: "$", code: "CONFIG_INVALID", message: line.trim() },
    );
  }
  if (out.length === 0) out.push({ path: "$", code: "CONFIG_INVALID", message: err.message });
  return out;
}

export interface ValidateDeps {
  /** The container runtime for `container` projects (default: the rootless Docker CLI driver). Test seam. */
  readonly makeRuntime?: () => ContainerRuntime;
}

export async function validateProjects(
  io: CliIo,
  argv: readonly string[],
  only?: string,
  deps: ValidateDeps = {},
): Promise<ProjectsValidation> {
  let config: ResolvedConfig;
  try {
    config = load(io, argv);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { schema_version: JSON_SCHEMA_VERSION, ok: false, projects: [], config_failures: configFailures(err) };
  }
  if (only !== undefined && !config.projects.some((p) => p.id === only)) {
    throw new UnknownProjectError(`unknown project ${only}`);
  }
  const projects: ProjectsValidation["projects"] = [];
  let runtime: ContainerRuntime | undefined;
  for (const [i, p] of config.projects.entries()) {
    if (only !== undefined && p.id !== only) continue;
    const failures = await checkProject(config, p, `$.projects[${i}]`);
    if (p.environment.kind === "container") {
      runtime ??= (deps.makeRuntime ?? createDockerRuntime)();
      failures.push(...(await checkContainerEnvironment(runtime, p, `$.projects[${i}].environment`)));
    }
    if (failures.length === 0) failures.push(...(await checkSigning(io, p, `$.projects[${i}]`)));
    projects.push({ id: p.id, ok: failures.length === 0, failures });
  }
  return {
    schema_version: JSON_SCHEMA_VERSION,
    ok: projects.every((p) => p.ok),
    projects,
    config_failures: [],
  };
}

/**
 * T9.10 (FR-GIT-10, LLD §12.3.1): for each context with `sign: true`, the repository's own configuration must not set
 * a signing key (`SIGNING_CONFIG_UNSAFE`, the controller would refuse to sign there), and the operator's signing setup
 * (global and system Git configuration plus the allowlisted variables of the environment this command runs in) must
 * produce a test signature in a throwaway scratch repository (`SIGNING_UNAVAILABLE`). Only reason codes are reported:
 * never the key, its fingerprint, the keyring path or the signing program's output. Run by `projects validate` only
 * (not at admission or for dynamic projects, whose `sign` waits for `projects approve`); at run time every signed
 * commit fails closed on its own.
 */
async function checkSigning(io: CliIo, p: ResolvedProject, at: string): Promise<ProjectFailure[]> {
  const out: ProjectFailure[] = [];
  let tested: Awaited<ReturnType<typeof testSignature>> | undefined;
  for (const [j, c] of p.contexts.entries()) {
    if (!c.sign) continue;
    const where = `${at}.contexts[${j}].sign`;
    if (await repoSigningConfigUnsafe(await realpath(c.path))) {
      out.push({
        path: where,
        code: "SIGNING_CONFIG_UNSAFE",
        message:
          "the repository's own Git configuration sets a signing key (gpg.* or user.signingkey); " +
          "move it to the global configuration",
      });
      continue;
    }
    tested ??= await testSignature({ sourceEnv: io.env });
    if (!tested.ok) {
      out.push({
        path: where,
        code: "SIGNING_UNAVAILABLE",
        message: `no test signature could be made with the operator's Git signing configuration (${tested.reason})`,
      });
    }
  }
  return out;
}

/**
 * T10.3 (FR-PRJ-05, FR-PRJ-08): environment availability of a `container` project, in the order `prepare` checks it;
 * the first failure stops the checks that depend on it. Codes: `CONTAINER_RUNTIME_UNAVAILABLE` (no answer, or not
 * rootless), `CONTAINER_IMAGE_NOT_PINNED`, `CONTAINER_IMAGE_NOT_PRESENT`, `CONTAINER_IMAGE_AMBIGUOUS`,
 * `CONTAINER_IMAGE_CHECK_FAILED` (the scan did not complete: not "clean") and `CONTAINER_IMAGE_HAS_GIT_CLIENT`.
 */
export async function checkContainerEnvironment(
  runtime: ContainerRuntime,
  p: ResolvedProject,
  at: string,
): Promise<ProjectFailure[]> {
  const fail = (where: string, code: string, message: string): ProjectFailure[] => [{ path: where, code, message }];
  try {
    const info = await runtime.info();
    if (!info.available) return fail(`${at}.kind`, "CONTAINER_RUNTIME_UNAVAILABLE", info.detail);
    if (!info.rootless) {
      return fail(
        `${at}.kind`,
        "CONTAINER_RUNTIME_UNAVAILABLE",
        `${info.detail}; only a rootless runtime is used (NFR-SEC-04)`,
      );
    }
    const digest = p.environment.imageDigest;
    if (digest === undefined) {
      return fail(`${at}.image_digest`, "CONTAINER_IMAGE_NOT_PINNED", "the project pins no image digest (ADR-0013)");
    }
    const resolved = await runtime.resolveImage(digest);
    if (resolved.kind === "not_present") {
      return fail(
        `${at}.image_digest`,
        "CONTAINER_IMAGE_NOT_PRESENT",
        `no local image has id or digest ${digest}; Switchboard never pulls (ADR-0013)`,
      );
    }
    if (resolved.kind === "ambiguous") {
      return fail(
        `${at}.image_digest`,
        "CONTAINER_IMAGE_AMBIGUOUS",
        `${resolved.imageIds.length} local images match ${digest}`,
      );
    }
    const probe = probeContainerName(`validate-${randomBytes(6).toString("hex")}`);
    try {
      const scan = await runtime.scanImageForGitClient(resolved.imageId, probe, {
        [SWITCHBOARD_PROJECT_LABEL]: p.id,
        [SWITCHBOARD_ROLE_LABEL]: "probe",
      });
      if (!scan.completed) {
        return fail(`${at}.image_digest`, "CONTAINER_IMAGE_CHECK_FAILED", `image ${resolved.imageId}: ${scan.detail}`);
      }
      if (scan.found.length > 0) {
        return fail(
          `${at}.image_digest`,
          "CONTAINER_IMAGE_HAS_GIT_CLIENT",
          `image ${resolved.imageId} has a Git client on its PATH (${scan.detail}); no run would start (FR-PRJ-05, ADR-0020)`,
        );
      }
    } finally {
      await runtime.remove(probe).catch(() => undefined);
    }
    return [];
  } catch (err) {
    return fail(`${at}.kind`, "CONTAINER_IMAGE_CHECK_FAILED", (err as Error).message);
  }
}

/** The T9.1 filesystem rules for one project; also run on dynamic projects (T9.9) at creation and at admission. */
export async function checkProject(
  config: Pick<ResolvedConfig, "allowedRoots">,
  p: ResolvedProject,
  at: string,
): Promise<ProjectFailure[]> {
  const out: ProjectFailure[] = [];
  for (const [j, c] of p.contexts.entries()) {
    const cat = `${at}.contexts[${j}]`;
    const fail = (code: string, message: string) => out.push({ path: `${cat}.path`, code, message });
    if (!path.isAbsolute(c.path)) {
      fail("PATH_NOT_ABSOLUTE", `repository path ${JSON.stringify(c.path)} must be absolute`);
      continue;
    }
    let canonical: string;
    try {
      canonical = await realpath(c.path);
    } catch {
      fail("PATH_NOT_FOUND", `repository path ${c.path} does not exist`);
      continue;
    }
    if (!isUnderAllowedRoot(canonical, config.allowedRoots)) {
      fail(
        "OUTSIDE_ALLOWED_ROOT",
        `repository path ${c.path} resolves to ${canonical}, which is not under an allowed root (FR-POL-10)`,
      );
      continue;
    }
    let top: string;
    try {
      top = await realpath(await gitText(["rev-parse", "--show-toplevel"], { cwd: canonical }));
    } catch {
      fail("NOT_A_GIT_REPO", `${canonical} is not a Git repository`);
      continue;
    }
    if (!isUnderAllowedRoot(top, config.allowedRoots)) {
      fail("OUTSIDE_ALLOWED_ROOT", `repository root ${top} is not under an allowed root`);
      continue;
    }
    try {
      await gitText(["rev-parse", "--verify", "--end-of-options", `${c.baseRef}^{commit}`], { cwd: canonical });
    } catch {
      out.push({
        path: `${cat}.base_ref`,
        code: "BASE_REF_NOT_FOUND",
        message: `base ref ${JSON.stringify(c.baseRef)} does not resolve to a commit in ${canonical}`,
      });
    }
  }
  return out;
}

export function renderProjectList(projects: readonly ProjectView[]): string {
  if (projects.length === 0) return "No projects configured.\n";
  return `${projects
    .map((p) => `${p.id}\t${p.environment.kind}\t${p.contexts.length} context(s)\t${p.name}`)
    .join("\n")}\n`;
}

export function renderProject(p: ProjectView): string {
  const lines = [`Project ${p.id}: ${p.name}`, `  environment: ${p.environment.kind}`];
  if (p.environment.image_digest) lines.push(`  image_digest: ${p.environment.image_digest}`);
  if (p.max_trust_profile) lines.push(`  max_trust_profile: ${p.max_trust_profile}`);
  if (p.allowed_providers) lines.push(`  allowed_providers: ${p.allowed_providers.join(", ")}`);
  if (p.inner_agent) lines.push(`  inner_agent: ${p.inner_agent}`);
  for (const c of p.contexts) {
    lines.push(
      `  context ${c.id} (${c.kind}${c.primary ? ", primary" : ""}${c.writable ? ", writable" : ""})`,
      `    path: ${c.path}`,
      `    base_ref: ${c.base_ref}`,
      `    push: ${c.push.policy}`,
    );
    if (c.identity) lines.push(`    identity: ${c.identity.name} <${c.identity.email}>`);
    if (c.finalize_commit) lines.push("    finalize_commit: on (FR-GIT-09)");
    if (c.sign) lines.push("    sign: on (FR-GIT-10)");
    if (c.inner_agent) lines.push(`    inner_agent: ${c.inner_agent}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderValidation(v: ProjectsValidation): string {
  const lines: string[] = [];
  for (const f of v.config_failures) lines.push(`[FAIL] ${f.path}: ${f.message}`);
  for (const p of v.projects) {
    lines.push(`[${p.ok ? "ok" : "FAIL"}] project ${p.id}`);
    for (const f of p.failures) lines.push(`  ${f.path}: ${f.message} (${f.code})`);
  }
  if (v.projects.length === 0 && v.config_failures.length === 0) lines.push("No projects configured.");
  return `${lines.join("\n")}\n`;
}
