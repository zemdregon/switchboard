/**
 * `switchboard adapters validate <provider>` (T4.4; FR-OPS-02, FR-ADP-02, FR-ADP-03, ADR-0009, LLD §6, Q-10, Q-12).
 *
 * Runs, in order and stopping at the first failure: the adapter's probe (FR-ADP-02 steps 1 to 5), its auth preflight
 * (only `OK` passes; `AUTH_REQUIRED` and `UNKNOWN` fail closed, NFR-SEC-06) and a live conformance subset: the static
 * adapter checks (`checkAdapterStatics`) and the structured-output smoke test (FR-ADP-02 step 7) against the installed
 * binary. The smoke test makes ONE real provider call: it compiles a trivial read-only task with the adapter's own
 * `compile` under `inspect-untrusted`, runs it in a throwaway Git repository and requires the adapter to parse a
 * successful structured `result`. It never logs in and never reads a credential file. Under `inspect-untrusted` it
 * never passes a bypass-class flag (the run goes through the same argv audit as every run, with no approval).
 *
 * Compiled-cell fallback (owner decisions 59 and 60, relayed by the orchestrator with standing authority on
 * 2026-10-18; Delegated reading): Grok Build, Cursor, Kimi Code, OpenCode and Antigravity compile only an approved
 * `privileged` bypass scope (owner decision 46; Kimi ADR-0049 item 1), so `inspect-untrusted` is `Ineligible` for
 * them by design. For those five adapter ids only ({@link COMPILED_CELL_FALLBACK}), and only when the
 * `inspect-untrusted` compile is `Ineligible`, the same smoke task (same objective, same throwaway repository, same
 * timeouts, same `startAdapterRun` and argv audit) runs in the adapter's only compiled cell: `privileged` with the
 * scope below, approved by an in-memory approval local to this one call (no ledger row, no client approval record,
 * no config change; nothing is persisted). Cursor, Kimi Code, OpenCode and Antigravity refuse a read-only workspace
 * in that cell, so the throwaway repository (a fresh temp repository with one commit and nothing else) is passed
 * writable for them. Before the spawn the bypass-class flags in the argv must be exactly the one flag the cell
 * declares — or, for OpenCode, which declares none (Q-83), no bypass-class flag at all; anything else fails the
 * smoke step. Every other adapter is unchanged: Claude Code and Codex still compile under `inspect-untrusted`, and
 * an adapter outside the list never falls back even if a `privileged` cell would compile.
 *
 * Only on full success does it write the provider's manifest file in the SOURCE tree (the file a contributor changes in
 * a pull request; the operator commits it): `validated_cli_version`, `validated_on`, `validated_version_range` (Q-12
 * convention: same minor series; an Assumption, not a provider statement) and one dated evidence line appended to
 * `notes`. The edit is a line-level text replacement, so every other byte of the file is unchanged. On ANY failure
 * nothing is written. Exit codes are decided by the caller (`main`): 0 success, 1 failure.
 *
 * Manifest location (Delegated, Assumption; LLD §6): the loaded manifest directory of a built package is the copy
 * under `dist/`, which is not the file a pull request changes. The command therefore resolves the source tree from this
 * module's own location (package root = two directories up, containing `package.json`, `src/adapters/manifests` and a
 * `.git` entry) and refuses, writing nothing, when that is not found (an installed package, not a checkout). Tests
 * inject a directory through `CliIo.manifestDir`; there is no flag for it.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBypassFlags } from "../adapters/audit.js";
import { checkAdapterStatics } from "../adapters/conformance.js";
import { ManifestError, parseManifest } from "../adapters/manifest/load.js";
import { parseVersion } from "../adapters/manifest/semver.js";
import { adapterIdForConfigId } from "../adapters/providers.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { createProbeRunner, startAdapterRun } from "../adapters/run.js";
import {
  type CompileRequest,
  isIneligible,
  type ProviderAdapter,
  type ProviderId,
  type ResolvedProfile,
} from "../adapters/types.js";
import { recordAdapterVersion } from "../adapters/version-canary.js";
import { defaultRedactor, REDACTION_MARKER } from "../artifacts/redact.js";
import { loadConfig } from "../config/index.js";
import { type PrivilegedScope, privilegedScopeHash, resolveProfile, resolveTrustProfile } from "../policy/index.js";
import { defaultAdapters } from "./doctor.js";
import { type CliIo, JSON_SCHEMA_VERSION, PROBE_ENV_ALLOWLIST, UsageError } from "./io.js";

/** Wall-clock bound of the one smoke call (Proposed, Assumption: generous for a one-word reply). */
export const SMOKE_TIMEOUT_MS = 120_000;
const SMOKE_OBJECTIVE = "Reply with the single word ok. Do not use any tools and do not modify any files.";
const REQUIRED_PROBE_STEPS = ["binary", "version", "command", "output_format", "flags"] as const;

/** The only compiled cell of an adapter that compiles nothing under `inspect-untrusted` (owner decisions 59, 60). */
export interface CompiledCell {
  /** The approved `privileged` scope the adapter compiles (its narrowest compiling bypass scope). */
  readonly scope: PrivilegedScope;
  /** Whether the throwaway repository is passed writable (the cell refuses a read-only workspace). */
  readonly writable: boolean;
  /**
   * The one bypass-class flag the cell declares (ADR-0035 registry), or null when the cell declares none: OpenCode's
   * privileged cell adds no bypass flag (Q-83), so its argv must carry no bypass-class flag at all.
   */
  readonly bypassFlag: string | null;
  /** The owner decision allowing this cell's fallback: 59 (grok, cursor, kimi) or 60 (opencode, antigravity). */
  readonly decision: 59 | 60;
}

/**
 * Owner decisions 59 and 60 allowlist: `adapters validate` MAY smoke in the adapter's only compiled cell under
 * inspect-untrusted for Grok Build, Cursor, Kimi Code (decision 59), OpenCode and Antigravity (decision 60).
 * Scopes follow each adapter's compile matrix:
 * - grok: read-only files need network `off` (`--sandbox read-only`), shell `broad`, repository config `enabled`;
 * - cursor: worktree files, shell `broad`, network `on`, repository config `enabled` (read-only is refused, Q-65, Q-79);
 * - kimi: the `--prompt` bypass cell, the same scope as Cursor (read-only is refused, ADR-0049 item 1);
 * - opencode: `privileged` + `bypass`, worktree files, shell `broad`, network `on`, repository config `enabled`
 *   (read-only is refused, Q-83); it emits no bypass flag, so `bypassFlag` is null and the argv must carry no
 *   bypass-class flag at all;
 * - antigravity: the same scope as OpenCode (read-only is refused, Q-84) with `--dangerously-skip-permissions`.
 */
export const COMPILED_CELL_FALLBACK: Readonly<Partial<Record<ProviderId, CompiledCell>>> = Object.freeze({
  grok: {
    scope: {
      files: { access: "read-only" },
      shell: { mode: "broad" },
      network: { mode: "off" },
      repository_config: { mode: "enabled" },
      bypass: true,
    },
    writable: false,
    bypassFlag: "--always-approve",
    decision: 59,
  },
  cursor: {
    scope: {
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    },
    writable: true,
    bypassFlag: "--force",
    decision: 59,
  },
  kimi: {
    scope: {
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    },
    writable: true,
    bypassFlag: "--prompt",
    decision: 59,
  },
  opencode: {
    scope: {
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    },
    writable: true,
    bypassFlag: null,
    decision: 60,
  },
  antigravity: {
    scope: {
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    },
    writable: true,
    bypassFlag: "--dangerously-skip-permissions",
    decision: 60,
  },
});

/** Placeholder approval id in the resolver's format; it names no approval row (nothing is persisted). */
const VALIDATE_APPROVAL_ID = "apv_00000000000000000000VA1DAT";
const FALLBACK_CELL_NOTE = "approved privileged bypass cell, owner decision 59; inspect-untrusted is Ineligible";
const FALLBACK_CELL_NOTE_60 = "approved privileged bypass cell, owner decision 60; inspect-untrusted is Ineligible";

/**
 * The validate-local `privileged` profile for `cell`, from the real resolver (so `bypassApproved` stays false on it).
 * The in-memory approval travels as the request's `bypassApproved` and the run's `bypassApproved` option, for this one
 * call only, as the conformance cases carry it.
 */
function cellProfile(provider: string, cell: CompiledCell): ResolvedProfile {
  const scopeHash = privilegedScopeHash({
    clientId: "switchboard-adapters-validate",
    metaSessionId: `validate-${provider}`,
    scope: cell.scope,
  });
  return resolveTrustProfile("privileged", {
    privileged: { scope: cell.scope, scopeHash, approvalId: VALIDATE_APPROVAL_ID },
  });
}

export type ValidateStatus = "ok" | "fail" | "skip";

export interface ValidateStep {
  readonly id: string;
  readonly status: ValidateStatus;
  readonly detail: string;
  /** Smoke step only: the profile the smoke task was compiled under (`inspect-untrusted` or `privileged`). */
  readonly smoke_profile?: string;
  /** Smoke FAIL only: the run's classified failure code (T4.4 failure-detail follow-up). */
  readonly failure_code?: string;
  /** Smoke FAIL only: the classifier's detail, redacted and clipped to one line; never raw stderr/stdout. */
  readonly failure_detail?: string;
}

export interface ValidateReport {
  readonly schema_version: number;
  readonly ok: boolean;
  readonly provider: string;
  readonly binary_version: string | null;
  readonly steps: ValidateStep[];
  /** True only when the manifest file was rewritten. */
  readonly written: boolean;
  readonly manifest_path: string | null;
  readonly changes: {
    readonly validated_cli_version: string;
    readonly validated_on: string;
    readonly validated_version_range: string;
    readonly notes_appended: string;
  } | null;
  readonly error: string | null;
}

/** Source-tree manifest directory, or null when this module does not run from a source checkout. */
export function sourceManifestDir(): string | null {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dir = path.join(root, "src", "adapters", "manifests");
  return existsSync(path.join(root, "package.json")) && existsSync(path.join(root, ".git")) && existsSync(dir)
    ? dir
    : null;
}

const clip = (s: string): string =>
  Array.from(s)
    .filter((c) => c >= " " && c !== "\x7f")
    .join("")
    .slice(0, 200);

/**
 * The classifier's `detail` as it may appear in output: the ledger's own secret redactor (the same patterns the
 * lifecycle applies to `failure_detail`), then e-mail addresses and URL query strings become the redaction marker
 * (the ledger patterns cover credential shapes, not those), then one line, clipped. Never call this on raw
 * stderr/stdout: only the classifier's detail reaches output.
 */
export function sanitizeFailureDetail(detail: string): string {
  const redacted = defaultRedactor(Buffer.from(detail, "utf8")).toString("utf8");
  return clip(
    redacted.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, REDACTION_MARKER).replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1"),
  );
}

/** Replaces the value of the single top-level `"key": "<string>"` line; null when the line is not found exactly once. */
function replaceStringLine(text: string, key: string, value: string): string | null {
  const re = new RegExp(`^(  "${key}": )"(?:[^"\\\\]|\\\\.)*"(,?)$`, "gm");
  if ([...text.matchAll(re)].length !== 1) return null;
  return text.replace(re, (_m, head: string, comma: string) => `${head}${JSON.stringify(value)}${comma}`);
}

/** Inserts `"notes"` as a new last property (the manifest has none yet). */
function insertNotes(text: string, value: string): string | null {
  const m = /^(.*[^,\s])\n\}\s*$/s.exec(text);
  if (!m) return null;
  return `${m[1]},\n  "notes": ${JSON.stringify(value)}\n}\n`;
}

/** Pure: the new manifest text for a validated version, or throws ManifestError when it cannot be produced safely. */
export function buildUpdatedManifest(
  original: string,
  provider: string,
  version: string,
  today: string,
  evidence: string,
): { text: string; changes: NonNullable<ValidateReport["changes"]> } {
  const old = parseManifest(original);
  const v = parseVersion(version);
  if (!v || v.prerelease) throw new ManifestError(`probed version ${JSON.stringify(version)} is not a release version`);
  const exact = `${v.major}.${v.minor}.${v.patch}`;
  const range = `>=${exact} <${v.major}.${v.minor + 1}.0`;
  const appended = `Evidence (adapters validate, ${today}): ${evidence}`;
  const notes = old.notes !== undefined && old.notes !== "" ? `${old.notes} ${appended}` : appended;

  let text: string | null = original;
  for (const [key, value] of [
    ["validated_cli_version", exact],
    ["validated_on", today],
    ["validated_version_range", range],
  ] as const) {
    text = replaceStringLine(text, key, value);
    if (text === null) throw new ManifestError(`cannot locate the ${key} line in the manifest file`);
  }
  text = old.notes !== undefined ? replaceStringLine(text, "notes", notes) : insertNotes(text, notes);
  if (text === null) throw new ManifestError("cannot locate the notes line in the manifest file");

  // Defence in depth: the result must validate and differ from the original in exactly the four fields.
  const next = parseManifest(text);
  const expected = {
    ...old,
    validated_cli_version: exact,
    validated_on: today,
    validated_version_range: range,
    notes,
  };
  if (next.provider !== provider || JSON.stringify(sortKeys(next)) !== JSON.stringify(sortKeys(expected))) {
    throw new ManifestError("the updated manifest would change fields other than the four validated fields");
  }
  return {
    text,
    changes: {
      validated_cli_version: exact,
      validated_on: today,
      validated_version_range: range,
      notes_appended: appended,
    },
  };
}

function sortKeys(o: object): unknown {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A throwaway Git repository with one commit, as the live smoke test uses (some CLIs refuse a non-Git directory). */
function makeSmokeRepo(): { dir: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "switchboard-validate-")));
  const repo = path.join(root, "repo");
  const env = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Switchboard Validate",
    GIT_AUTHOR_EMAIL: "validate@example.invalid",
    GIT_COMMITTER_NAME: "Switchboard Validate",
    GIT_COMMITTER_EMAIL: "validate@example.invalid",
  };
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env, stdio: "ignore" });
    writeFileSync(path.join(repo, "README.md"), "# Throwaway repository for switchboard adapters validate\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { env, stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], {
      env,
      stdio: "ignore",
    });
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return { dir: repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function resolveAdapter(registry: AdapterRegistry, arg: string): ProviderAdapter | undefined {
  const id = (registry.has(arg as ProviderId) ? arg : adapterIdForConfigId(arg)) as ProviderId | undefined;
  return id === undefined ? undefined : registry.get(id);
}

export async function runAdaptersValidate(
  io: CliIo,
  providerArg: string,
  configArgv: readonly string[] = [],
): Promise<ValidateReport> {
  const registry = io.adapters ?? defaultAdapters();
  const adapter = resolveAdapter(registry, providerArg);
  if (!adapter) {
    const known = registry
      .list()
      .map((a) => a.id)
      .join(", ");
    throw new UsageError(`unknown provider ${JSON.stringify(providerArg)}; expected one of: ${known}`);
  }
  const provider = adapter.id;
  const steps: ValidateStep[] = [];
  let binaryVersion: string | null = null;
  const done = (error: string | null, extra: Partial<ValidateReport> = {}): ValidateReport => ({
    schema_version: JSON_SCHEMA_VERSION,
    ok: error === null && extra.written === true,
    provider,
    binary_version: binaryVersion,
    steps,
    written: false,
    manifest_path: null,
    changes: null,
    error,
    ...extra,
  });
  const fail = (id: string, detail: string): ValidateReport => {
    steps.push({ id, status: "fail", detail });
    return done(`${id}: ${detail}`);
  };

  // 0. The manifest file must be locatable and valid before any provider process runs.
  const dir = io.manifestDir ?? sourceManifestDir();
  if (dir === null) {
    return fail(
      "manifest",
      "no source checkout found (an installed package cannot record a validation); run this command from a clone of the repository",
    );
  }
  const manifestPath = path.join(dir, `${provider}.json`);
  let original: Buffer;
  try {
    original = readFileSync(manifestPath);
    const m = parseManifest(original.toString("utf8"));
    if (m.provider !== provider) throw new ManifestError(`declares provider ${m.provider}, expected ${provider}`);
  } catch (err) {
    return fail("manifest", `${manifestPath}: ${clip((err as Error).message)}`);
  }
  steps.push({ id: "manifest", status: "ok", detail: manifestPath });

  const runner = createProbeRunner(PROBE_ENV_ALLOWLIST);

  // 1. Probe (FR-ADP-02 steps 1 to 5).
  try {
    const probe = await adapter.probe(runner);
    binaryVersion = probe.binaryVersion;
    const bad = REQUIRED_PROBE_STEPS.filter((s) => probe.steps.find((p) => p.step === s)?.ok !== true);
    const extraBad = probe.steps.filter((p) => !p.ok && !(REQUIRED_PROBE_STEPS as readonly string[]).includes(p.step));
    if (bad.length > 0 || extraBad.length > 0) {
      return fail(
        "probe",
        `failed or missing steps: ${[...bad, ...extraBad.map((p) => p.step)].join(", ")}${probe.steps.find((p) => !p.ok)?.detail ? ` (${clip(probe.steps.find((p) => !p.ok)?.detail ?? "")})` : ""}`,
      );
    }
    const v = parseVersion(binaryVersion);
    if (!v || v.prerelease) return fail("probe", `version ${JSON.stringify(binaryVersion)} is not a release version`);
    steps.push({
      id: "probe",
      status: "ok",
      detail: `steps ${REQUIRED_PROBE_STEPS.join(", ")} ok; version ${binaryVersion}`,
    });
  } catch (err) {
    return fail("probe", clip((err as Error).message));
  }

  // 2. Auth preflight: the adapter's own status mechanism; never a login. Only OK passes.
  try {
    const auth = await adapter.authPreflight(runner);
    if (auth.state === "AUTH_REQUIRED")
      return fail("auth", `AUTH_REQUIRED: log in natively (${clip(auth.loginCommand)}) and run this again`);
    if (auth.state === "UNKNOWN") return fail("auth", `UNKNOWN (fail closed): ${clip(auth.reason)}`);
    steps.push({ id: "auth", status: "ok", detail: "OK" });
  } catch (err) {
    return fail("auth", `UNKNOWN (fail closed): ${clip((err as Error).message)}`);
  }

  // 3. Live conformance subset: static checks, then the structured-output smoke test (one provider call).
  let repo: ReturnType<typeof makeSmokeRepo> | undefined;
  let fallback: CompiledCell | undefined;
  try {
    repo = makeSmokeRepo();
    let profile: ResolvedProfile = resolveProfile("inspect-untrusted");
    let request: CompileRequest = {
      runId: "run_validate",
      objective: SMOKE_OBJECTIVE,
      constraints: [],
      workspace: { cwd: repo.dir, writable: false },
    };
    // Owner decisions 59 and 60: inspect-untrusted first; only an allowlisted adapter for which it is
    // Ineligible falls back.
    const cell = COMPILED_CELL_FALLBACK[provider];
    if (cell !== undefined && isIneligible(adapter.compile(request, profile))) {
      fallback = cell;
      profile = cellProfile(provider, cell);
      request = { ...request, workspace: { cwd: repo.dir, writable: cell.writable }, bypassApproved: true };
    }
    // The step detail and evidence line name the ruling that allows this cell's fallback (59 or 60).
    const cellNote = fallback?.decision === 60 ? FALLBACK_CELL_NOTE_60 : FALLBACK_CELL_NOTE;
    const smokeProfile = profile.name;
    const statics = checkAdapterStatics({
      kind: "success",
      adapter,
      request,
      profile,
      expect: { ok: true },
    });
    const staticsBad = statics.filter((c) => !c.ok);
    if (staticsBad.length > 0) {
      return fail("conformance", `static checks failed: ${staticsBad.map((c) => clip(c.name)).join("; ")}`);
    }
    steps.push({
      id: "conformance",
      status: "ok",
      detail: `${statics.length} static checks ok${fallback ? ` (${cellNote})` : ""}`,
    });

    const smokeFail = (detail: string): ValidateReport => {
      steps.push({ id: "smoke", status: "fail", detail, smoke_profile: smokeProfile });
      return done(`smoke: ${detail}`);
    };
    const inv = adapter.compile(request, profile);
    if (isIneligible(inv)) return smokeFail(`${smokeProfile} is ineligible: ${inv.reason}: ${clip(inv.detail)}`);
    if (fallback) {
      // The approved context admits every bypass flag in the audit, so the cell's argv is narrowed here: exactly the
      // one flag the cell declares, nothing else bypass-class (provider-scoped flags included); a cell that declares
      // no flag (OpenCode, Q-83) admits none at all.
      const found = findBypassFlags(inv, provider);
      const ruling = `owner decision ${fallback.decision}`;
      if (fallback.bypassFlag === null) {
        if (found.length !== 0) {
          return smokeFail(
            `bypass-class flags in the compiled argv: ${found.map(clip).join(", ")}; none allowed (${ruling})`,
          );
        }
      } else if (found.length !== 1 || found[0] !== fallback.bypassFlag) {
        return smokeFail(
          `bypass-class flags in the compiled argv: ${found.map(clip).join(", ") || "none"}; only ${fallback.bypassFlag} is allowed (${ruling})`,
        );
      }
    }
    const bounded = {
      ...inv,
      timeouts: {
        ...inv.timeouts,
        wallClockMs: Math.min(inv.timeouts.wallClockMs, SMOKE_TIMEOUT_MS),
        idleMs: Math.min(inv.timeouts.idleMs, SMOKE_TIMEOUT_MS),
      },
    };
    const outcome = await startAdapterRun(adapter, bounded, fallback ? { profile, bypassApproved: true } : { profile })
      .done;
    const sawResult = outcome.events.some((e) => e.kind === "result" && e.ok);
    if (!outcome.result.ok || !sawResult || !outcome.groupEmpty) {
      const code =
        outcome.result.failureCode ?? (sawResult ? "process group not empty" : "no successful structured result");
      const safeDetail =
        outcome.result.failureDetail !== undefined && outcome.result.failureDetail !== ""
          ? sanitizeFailureDetail(outcome.result.failureDetail)
          : null;
      const text =
        `structured-output smoke test failed: ${clip(code)} (exit code ${outcome.exit.exitCode ?? "unknown"})` +
        (safeDetail === null ? "" : `: ${safeDetail}`);
      steps.push({
        id: "smoke",
        status: "fail",
        detail: text,
        smoke_profile: smokeProfile,
        failure_code: clip(code),
        ...(safeDetail === null ? {} : { failure_detail: safeDetail }),
      });
      return done(`smoke: ${text}`);
    }
    steps.push({
      id: "smoke",
      status: "ok",
      detail: `one provider call; a successful structured result was parsed${fallback ? ` (${cellNote})` : ""}`,
      smoke_profile: smokeProfile,
    });
  } catch (err) {
    return fail("smoke", clip((err as Error).message));
  } finally {
    repo?.cleanup();
  }

  // 4. Record the validation: the four fields only, atomically, and only if the file is still what we read.
  try {
    const today = (io.now ?? (() => new Date()))().toISOString().slice(0, 10);
    const evidenceNote =
      fallback === undefined
        ? "inspect-untrusted, no bypass flag"
        : fallback.decision === 60
          ? FALLBACK_CELL_NOTE_60
          : FALLBACK_CELL_NOTE;
    const evidence =
      `\`switchboard adapters validate ${provider}\` passed on version ${binaryVersion}: probe steps ${REQUIRED_PROBE_STEPS.join(", ")} ok, ` +
      `auth OK, static conformance checks ok and one structured-output smoke call ok (${evidenceNote}). ` +
      "The range is the same minor series (Q-12 convention, an Assumption, not a provider statement).";
    const { text, changes } = buildUpdatedManifest(
      original.toString("utf8"),
      provider,
      binaryVersion ?? "",
      today,
      evidence,
    );
    if (!readFileSync(manifestPath).equals(original)) {
      return fail("write", "the manifest file changed while validating; nothing written");
    }
    const tmp = `${manifestPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, text, { mode: statSync(manifestPath).mode & 0o777 });
      renameSync(tmp, manifestPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    steps.push({ id: "write", status: "ok", detail: `${manifestPath} updated; review and commit it` });
    try {
      const cfg = loadConfig({
        argv: configArgv,
        env: io.env,
        ...(io.homedir !== undefined ? { homedir: io.homedir } : {}),
      });
      if (binaryVersion !== null) {
        recordAdapterVersion(cfg.dataDir, provider, binaryVersion, io.now ?? (() => new Date()));
      }
    } catch {
      // Recording the canary baseline is best-effort when config is unavailable; validation still succeeded.
    }
    return done(null, { written: true, manifest_path: manifestPath, changes });
  } catch (err) {
    return fail("write", `nothing written: ${clip((err as Error).message)}`);
  }
}

const MARK: Record<ValidateStatus, string> = { ok: "[ok]  ", fail: "[FAIL]", skip: "[skip]" };

export function renderValidate(r: ValidateReport): string {
  const lines = [`switchboard adapters validate ${r.provider}`, ""];
  for (const s of r.steps) lines.push(`${MARK[s.status]} ${s.id}: ${s.detail}`);
  if (r.ok && r.changes) {
    lines.push(
      "",
      `Recorded validated_cli_version ${r.changes.validated_cli_version}, validated_on ${r.changes.validated_on}, validated_version_range "${r.changes.validated_version_range}" and an evidence line in notes.`,
      "Review the change and commit the manifest file yourself; nothing was committed.",
      "Result: OK",
    );
  } else {
    lines.push("", "Nothing was written.", "Result: FAILED");
  }
  return `${lines.join("\n")}\n`;
}
