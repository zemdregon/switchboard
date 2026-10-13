/**
 * Scratch adapter fixture (T4.1 "Done when"; NFR-MAINT-01). SYNTHETIC: "scratch" is not a real provider and
 * `--scratch-skip-all-checks`, `-k` and `--scratch-guard off` are not real flags or values. The module is the whole
 * addition a new adapter would make outside its manifest and fixtures: an adapter and one provider registry entry,
 * registered at runtime by the test with `registerProvider` (no other source file names it). It runs the bundled fake
 * CLI, so no provider is needed.
 */
import { FakeAdapter } from "../fake/adapter.js";
import type { ProviderEntry } from "../providers.js";
import type {
  CompileRequest,
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
/** Its (synthetic) bypass-class flag value (ADR-0037): `--scratch-guard off` and `--scratch-guard=off` are refused. */
export const SCRATCH_BYPASS_VALUE = { flag: "--scratch-guard", value: "off" } as const;

/**
 * The fake adapter under another id. `ProviderId` is the built-in union (`./providers.ts`), so a runtime id needs this
 * cast; an adapter added to the built-in table gets its id into the union instead.
 */
export class ScratchAdapter implements ProviderAdapter {
  readonly id = SCRATCH_ID as ProviderId;
  readonly #inner = new FakeAdapter({ commitChannel: "none" });
  readonly transports = this.#inner.transports;
  readonly gitWriteControl = this.#inner.gitWriteControl;
  readonly gitCapabilities = this.#inner.gitCapabilities;
  readonly probe = this.#inner.probe.bind(this.#inner);
  readonly authPreflight = this.#inner.authPreflight.bind(this.#inner);
  readonly parseEvent = this.#inner.parseEvent.bind(this.#inner);
  readonly extractResult = this.#inner.extractResult.bind(this.#inner);
  readonly classifyFailure = this.#inner.classifyFailure.bind(this.#inner);

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
    if (!approvedBypass) return this.#inner.compile(request, profile);
    const base = this.#inner.compile(request, { ...profile, name: "edit-untrusted", bypassApproved: false });
    if ("ineligible" in base) return base;
    return { ...base, argv: [...base.argv, SCRATCH_BYPASS_FLAG], policyFlags: [SCRATCH_BYPASS_FLAG] };
  }

  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#inner.resumeArgs({ ...binding, provider: "fake" }, request, profile);
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
  create: () => new ScratchAdapter(),
};
