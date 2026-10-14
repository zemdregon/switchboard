/**
 * Continuity fakes (T5.2; FR-ADP-11, NFR-MAINT-01, FR-EXE-07). TEST-ONLY and SYNTHETIC: "fake-b" is not a real provider
 * and `--continue-session` is not a real flag. Two fake providers, each the bundled fake CLI (`../fake/cli.mjs`) under
 * its own provider id, native session ids and resume flag, that keep a canary "transcript" and the received prompt under
 * a state directory beneath a HOME the test chose, as real CLIs keep sessions under the home directory (ADR-0001
 * names `~/.claude/projects/*.jsonl` and `~/.grok/sessions/`). `HOME` reaches the child through the invocation's
 * environment allowlist (`envAllowlist`), with its value in the invocation's declared variables.
 *
 * The second fake is the whole addition a new adapter makes outside its manifest and fixtures (an adapter and one
 * registry entry, {@link SECOND_FAKE_PROVIDER}); no production source names it. The caller registers it at runtime with
 * `registerProvider`, as the T4.1 scratch adapter does.
 */

import type { ConformanceCase } from "../conformance.js";
import { FakeAdapter, type FakeAdapterOptions } from "../fake/adapter.js";
import { FAKE_PROFILE } from "../fake/cases.js";
import type { ProviderEntry } from "../providers.js";
import type {
  AcpMessage,
  CompileRequest,
  Ineligible,
  Invocation,
  NativeBinding,
  NormalizedEvent,
  ParseState,
  ProviderAdapter,
  ProviderId,
  ResolvedProfile,
} from "../types.js";

/** Typed as `ProviderId` by a cast: the built-in union cannot name a runtime id (tests only), as in the scratch fixture. */
export const SECOND_FAKE_ID = "fake-b" as ProviderId;
export const SECOND_FAKE_CONFIG_ID = "fake-b-cli";
/** The second fake's own resume flag (the first fake's is `--resume`). */
export const SECOND_FAKE_RESUME_FLAG = "--continue-session";
/** The id its fresh sessions get (the first fake's is `fake-session-1`). */
export const SECOND_FAKE_SESSION_ID = "fake-b-session-1";
/** State directory names, relative to HOME. */
export const FIRST_FAKE_STATE_DIR = ".fake-a";
export const SECOND_FAKE_STATE_DIR = ".fake-b";

/** What the fake CLI reports about its state files (the `state` message of `cli.mjs`). */
export interface StateReport {
  readonly session_id: string;
  readonly canary_path: string;
  readonly prompt_log: string;
}

export interface StatefulFakeOptions extends FakeAdapterOptions {
  /** The temporary HOME the provider keeps its state under. */
  readonly home: string;
}

interface Spec {
  readonly id: ProviderId;
  readonly stateDir: string;
  /** Undefined: the bundled CLI's own defaults (`--resume`, `fake-session-1`). */
  readonly resumeFlag?: string;
  readonly sessionId?: string;
}

/** A fake adapter that keeps state under `home`. The first fake keeps its id `fake`; the second has its own. */
class StatefulFakeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #inner: FakeAdapter;
  readonly #spec: Spec;
  readonly #home: string;
  readonly transports;
  readonly gitWriteControl;
  readonly resumeCwd;
  readonly gitCapabilities;
  readonly probe;
  readonly authPreflight;
  readonly extractResult;
  readonly classifyFailure;
  /** Every state report the CLI emitted through `parseEvent`, in order (what a test asserts on). */
  readonly reports: StateReport[] = [];

  constructor(spec: Spec, opts: StatefulFakeOptions) {
    const { home, ...fakeOpts } = opts;
    this.#spec = spec;
    this.#home = home;
    this.id = spec.id;
    this.#inner = new FakeAdapter({ commitChannel: "none", ...fakeOpts });
    this.transports = this.#inner.transports;
    this.gitWriteControl = this.#inner.gitWriteControl;
    this.resumeCwd = this.#inner.resumeCwd;
    this.gitCapabilities = this.#inner.gitCapabilities;
    this.probe = this.#inner.probe.bind(this.#inner);
    this.authPreflight = this.#inner.authPreflight.bind(this.#inner);
    this.extractResult = this.#inner.extractResult.bind(this.#inner);
    this.classifyFailure = this.#inner.classifyFailure.bind(this.#inner);
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#withState(this.#inner.compile(request, profile));
  }

  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== this.id) {
      return { ineligible: true, reason: "CAPABILITY_MISSING", detail: `binding is for ${binding.provider}` };
    }
    return this.#withState(this.#inner.resumeArgs({ ...binding, provider: "fake" }, request, profile));
  }

  #withState(inv: Invocation | Ineligible): Invocation | Ineligible {
    if ("ineligible" in inv) return inv;
    const flag = this.#spec.resumeFlag;
    const argv = flag === undefined ? [...inv.argv] : inv.argv.map((a) => (a === "--resume" ? flag : a));
    argv.push("--state-dir", this.#spec.stateDir);
    if (flag !== undefined) argv.push("--resume-flag", flag);
    if (this.#spec.sessionId !== undefined) argv.push("--new-session-id", this.#spec.sessionId);
    return {
      ...inv,
      argv,
      env: { ...inv.env, HOME: this.#home },
      envAllowlist: [...inv.envAllowlist, "HOME"],
    };
  }

  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    const events = this.#inner.parseEvent(input, state);
    for (const e of events) {
      if (e.kind !== "message") continue;
      try {
        const report = (JSON.parse(e.text) as { state?: StateReport }).state;
        if (report !== undefined && typeof report.canary_path === "string") this.reports.push(report);
      } catch {
        // Not a state report.
      }
    }
    return events;
  }
}

export type StatefulFake = StatefulFakeAdapter;

/** The first fake (`fake`, `--resume`, `fake-session-1`) keeping its state under `home`/{@link FIRST_FAKE_STATE_DIR}. */
export function firstFake(opts: StatefulFakeOptions): StatefulFake {
  return new StatefulFakeAdapter({ id: "fake", stateDir: FIRST_FAKE_STATE_DIR }, opts);
}

/** The second fake: own id, own resume flag, own session ids, state under `home`/{@link SECOND_FAKE_STATE_DIR}. */
export function secondFake(opts: StatefulFakeOptions): StatefulFake {
  return new StatefulFakeAdapter(
    {
      id: SECOND_FAKE_ID,
      stateDir: SECOND_FAKE_STATE_DIR,
      resumeFlag: SECOND_FAKE_RESUME_FLAG,
      sessionId: SECOND_FAKE_SESSION_ID,
    },
    opts,
  );
}

/** The one registry entry for the second fake (what a new adapter adds to `BUILTIN_PROVIDERS`). */
export function secondFakeProvider(home: string): ProviderEntry {
  return {
    id: SECOND_FAKE_ID,
    configId: SECOND_FAKE_CONFIG_ID,
    kind: "real",
    label: "Second fake CLI (synthetic T5.2 test adapter)",
    bypassFlags: [],
    create: () => secondFake({ home }),
  };
}

const SHORT = { wallClockMs: 10_000, idleMs: 400, killGraceMs: 300 };

/**
 * Conformance cases for either fake (every `REQUIRED_CASE_KINDS` case, including `resume`), through the state-keeping
 * adapter. `makeCwd` returns a fresh empty directory per case; `home` is a temporary HOME.
 */
export function continuityConformanceCases(
  which: "first" | "second",
  home: string,
  makeCwd: () => string,
): ConformanceCase[] {
  const second = which === "second";
  const make = (scenario: NonNullable<FakeAdapterOptions["scenario"]>, timeouts?: Partial<typeof SHORT>) => {
    const o = { home, scenario, timeouts: { ...SHORT, ...timeouts } };
    return second ? secondFake(o) : firstFake(o);
  };
  const request = (): CompileRequest => ({
    runId: "run_fake",
    objective: "do the thing",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
  });
  const base = { profile: FAKE_PROFILE } as const;
  const freshId = second ? SECOND_FAKE_SESSION_ID : "fake-session-1";
  const resumeId = second ? "fake-b-session-42" : "fake-session-42";
  return [
    {
      ...base,
      kind: "success",
      adapter: make("success"),
      request: request(),
      expect: { ok: true, nativeSessionId: freshId },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: make("task_failure"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
    },
    {
      ...base,
      kind: "auth_missing",
      adapter: make("auth_missing"),
      request: request(),
      expect: { ok: false, failureCode: "AUTH_REQUIRED" },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: make("malformed_output"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: make("hang_ignore_term", { idleMs: 10_000 }),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED" },
    },
    {
      ...base,
      kind: "resume",
      adapter: make("success"),
      request: request(),
      binding: { provider: second ? SECOND_FAKE_ID : "fake", nativeSessionId: resumeId },
      expect: { ok: true, nativeSessionId: resumeId },
    },
  ];
}
