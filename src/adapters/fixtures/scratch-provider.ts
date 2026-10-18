/**
 * Scratch adapter fixture (T4.1 "Done when"; NFR-MAINT-01). SYNTHETIC: "scratch" is not a real provider and
 * `--scratch-skip-all-checks`, `-k` and `--scratch-guard off` are not real flags or values. The module is the whole
 * addition a new adapter would make outside its manifest and fixtures: an adapter and one provider registry entry,
 * registered at runtime by the test with `registerProvider` (no other source file names it). It runs the bundled fake
 * CLI, so no provider is needed. With `launcherArgs` it runs the shared replay helper (`replay.mjs --provider scratch`,
 * T4.3) instead, over the SYNTHETIC fixtures in `./scratch/`. `src/adapters/checklist.test.ts` holds it to every TDD
 * §4.9 checklist item (T4.2).
 */
import { FakeAdapter } from "../fake/adapter.js";
import type { ProviderEntry } from "../providers.js";
import type {
  CompileRequest,
  GitCapabilities,
  Ineligible,
  Invocation,
  NativeBinding,
  ProviderAdapter,
  ProviderId,
  ResolvedProfile,
} from "../types.js";

export const SCRATCH_ID = "scratch";
export const SCRATCH_CONFIG_ID = "scratch-cli";
/** The scratch provider's (synthetic) bypass-class flag, declared in its registry entry. */
export const SCRATCH_BYPASS_FLAG = "--scratch-skip-all-checks";
/** Its (synthetic) short bypass-class spelling (ADR-0037): refused alone and inside a cluster such as `-qk`. */
export const SCRATCH_BYPASS_SHORT_FLAG = "-k";
/**
 * Its (synthetic) isolation flag: stands for the flag a real CLI documents to switch repository configuration (hooks,
 * MCP definitions, instruction files) off. Emitted in every compiled argv; the fake CLI ignores it, the scratch replay
 * dialect requires it and the malicious leg (TDD §4.9 item 9) checks it is present.
 */
export const SCRATCH_ISOLATION_FLAG = "--scratch-no-repo-config";
/** Its (synthetic) bypass-class flag value (ADR-0037): `--scratch-guard off` and `--scratch-guard=off` are refused. */
export const SCRATCH_BYPASS_VALUE = { flag: "--scratch-guard", value: "off" } as const;

export interface ScratchAdapterOptions {
  /**
   * Replaces the fake CLI script in argv with these words (`replayLauncher("scratch", fixture, ...)`), so the run
   * replays a fixture through the shared helper; the adapter's own argv (`--scenario ...`) follows them.
   */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
}

/**
 * FR-GIT-09 (TDD §4.9 item 10): the fail-closed commit channel. The synthetic CLI has no tool channel, so nothing is
 * injected and the controller commits at FINALIZING when the project opts in.
 */
export const SCRATCH_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "finalize-only",
  detail: "synthetic scratch test adapter: no tool channel exists, so nothing is injected (FR-GIT-09)",
};

/**
 * The fake adapter under another id. `ProviderId` is the built-in union (`./providers.ts`), so a runtime id needs this
 * cast; an adapter added to the built-in table gets its id into the union instead.
 */
export class ScratchAdapter implements ProviderAdapter {
  readonly id = SCRATCH_ID as ProviderId;
  readonly #inner: FakeAdapter;
  readonly #launcherArgs: readonly string[] | undefined;
  readonly transports: ProviderAdapter["transports"];
  readonly gitWriteControl: ProviderAdapter["gitWriteControl"];
  readonly resumeCwd: ProviderAdapter["resumeCwd"];
  readonly gitCapabilities = SCRATCH_GIT_CAPABILITIES;
  readonly probe: ProviderAdapter["probe"];
  readonly authPreflight: ProviderAdapter["authPreflight"];
  readonly parseEvent: ProviderAdapter["parseEvent"];
  readonly extractResult: ProviderAdapter["extractResult"];
  readonly classifyFailure: ProviderAdapter["classifyFailure"];

  constructor(opts: ScratchAdapterOptions = {}) {
    this.#inner = new FakeAdapter({ commitChannel: "none", ...(opts.timeouts ? { timeouts: opts.timeouts } : {}) });
    this.#launcherArgs = opts.launcherArgs;
    this.transports = this.#inner.transports;
    this.gitWriteControl = this.#inner.gitWriteControl;
    this.resumeCwd = this.#inner.resumeCwd;
    this.probe = this.#inner.probe.bind(this.#inner);
    this.authPreflight = this.#inner.authPreflight.bind(this.#inner);
    this.parseEvent = this.#inner.parseEvent.bind(this.#inner);
    this.extractResult = this.#inner.extractResult.bind(this.#inner);
    this.classifyFailure = this.#inner.classifyFailure.bind(this.#inner);
  }

  /**
   * Emits {@link SCRATCH_BYPASS_FLAG} only for an approved `privileged` scope that sets `bypass` (the FR-POL-03 gate
   * every adapter applies); every other `privileged` request is Ineligible, as the fake's own compile has no
   * privileged mode.
   */
  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    const approvedBypass =
      profile.name === "privileged" &&
      profile.privilegedScope?.scope.bypass === true &&
      (profile.bypassApproved || request.bypassApproved === true);
    if (!approvedBypass) return this.#launch(this.#inner.compile(request, profile));
    const base = this.#inner.compile(request, { ...profile, name: "edit-untrusted", bypassApproved: false });
    if ("ineligible" in base) return base;
    return this.#launch({ ...base, argv: [...base.argv, SCRATCH_BYPASS_FLAG], policyFlags: [SCRATCH_BYPASS_FLAG] });
  }

  /** Resumes only a binding of this provider (FR-SES-03); the fake CLI's `--resume <id>` carries the session id. */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== this.id) {
      return { ineligible: true, reason: "CAPABILITY_MISSING", detail: `binding is for ${binding.provider}` };
    }
    return this.#launch(this.#inner.resumeArgs({ ...binding, provider: "fake" }, request, profile));
  }

  /**
   * Appends {@link SCRATCH_ISOLATION_FLAG}; with `launcherArgs`, the fake CLI script (argv[1]) gives way to the replay
   * launcher.
   */
  #launch(inv: Invocation | Ineligible): Invocation | Ineligible {
    if ("ineligible" in inv) return inv;
    const [exe = "", script = "", ...rest] = inv.argv;
    return { ...inv, argv: [exe, ...(this.#launcherArgs ?? [script]), ...rest, SCRATCH_ISOLATION_FLAG] };
  }
}

/** The one registry entry (what a new adapter adds to `BUILTIN_PROVIDERS`). */
export const SCRATCH_PROVIDER: ProviderEntry = {
  id: SCRATCH_ID,
  configId: SCRATCH_CONFIG_ID,
  kind: "real",
  label: "Scratch CLI (synthetic T4.1 test adapter)",
  bypassFlags: [SCRATCH_BYPASS_FLAG],
  bypassShortFlags: [SCRATCH_BYPASS_SHORT_FLAG],
  bypassValues: [SCRATCH_BYPASS_VALUE],
  resumeCwd: "bound",
  create: () => new ScratchAdapter(),
};
