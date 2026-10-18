/**
 * Test-only (excluded from the build), SYNTHETIC: replay fixtures, manifest directory and FR-ADP-11 conformance cases
 * for the T4.1 scratch adapter (TDD §4.9 items 2, 7 and 8; T4.2). The fixtures are hand-written in the fake CLI's event
 * shapes (`src/adapters/fake/cli.mjs`) and replayed by the shared `replay.mjs --provider scratch`; scratch is not a real
 * provider, so there is no capture to replace them with.
 */
import { fileURLToPath } from "node:url";
import { resolveTrustProfile } from "../../../policy/profiles.js";
import type { ConformanceCase } from "../../conformance.js";
import type { CompileRequest, ProviderId, ResolvedProfile } from "../../types.js";
import { replayLauncher } from "../replay.js";
import { SCRATCH_ID, ScratchAdapter } from "../scratch-provider.js";

/** The directory holding the scratch adapter's test-only compliance manifest (`loadManifest(id, dir)`). */
export const SCRATCH_MANIFEST_DIR = fileURLToPath(new URL("./manifests/", import.meta.url));

/** Every replay fixture in this directory, by name. */
export const SCRATCH_FIXTURES = [
  "success",
  "task_failure",
  "auth_missing",
  "malformed_output",
  "resume",
  "hang",
  "rate_limit",
] as const;
export type ScratchFixture = (typeof SCRATCH_FIXTURES)[number];

export const scratchFixturePath = (name: ScratchFixture): string =>
  fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

/** Session id of the fixtures that bind one (SYNTHETIC). */
export const SCRATCH_SESSION_ID = "scratch-session-0001";
/** Session id a resume case binds; the replay substitutes it for `{{SESSION_ID}}`. */
export const SCRATCH_RESUMED_SESSION_ID = "scratch-session-0042";

export const SCRATCH_EDIT_PROFILE: ResolvedProfile = resolveTrustProfile("edit-untrusted");

const SHORT = { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 };

/** A scratch adapter that replays `fixture` through the shared helper instead of running the fake CLI. */
export function scratchReplayAdapter(fixture: string, extra: readonly string[] = []): ScratchAdapter {
  return new ScratchAdapter({ launcherArgs: replayLauncher(SCRATCH_ID, fixture, extra), timeouts: SHORT });
}

/** Conformance cases over the fixtures (FR-ADP-11): every `REQUIRED_CASE_KINDS` kind plus `rate_limit`. */
export function scratchConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (): CompileRequest => ({
    runId: "run_scratch_conformance",
    objective: "synthetic scratch objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
  });
  const adapter = (name: ScratchFixture) => scratchReplayAdapter(scratchFixturePath(name));
  const base = { profile: SCRATCH_EDIT_PROFILE } as const;
  return [
    {
      ...base,
      kind: "success",
      adapter: adapter("success"),
      request: request(),
      expect: {
        ok: true,
        nativeSessionId: SCRATCH_SESSION_ID,
        summary: "Added hello.txt.",
        unknownEventCount: 0,
        mutatedPath: "hello.txt",
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: adapter("task_failure"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "Tests still fail.",
        nativeSessionId: SCRATCH_SESSION_ID,
        summary: "Tests still fail.",
      },
    },
    {
      ...base,
      kind: "auth_missing",
      adapter: adapter("auth_missing"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "AUTH_REQUIRED",
        failureDetail: "auth: SYNTHETIC: not logged in",
        nativeSessionId: null,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: adapter("malformed_output"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: SCRATCH_SESSION_ID, summary: null },
    },
    {
      ...base,
      kind: "resume",
      adapter: adapter("resume"),
      request: request(),
      binding: { provider: SCRATCH_ID as ProviderId, nativeSessionId: SCRATCH_RESUMED_SESSION_ID },
      expect: { ok: true, nativeSessionId: SCRATCH_RESUMED_SESSION_ID, summary: "Resumed and finished." },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: adapter("hang"),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED", nativeSessionId: SCRATCH_SESSION_ID },
    },
    {
      ...base,
      kind: "rate_limit",
      adapter: adapter("rate_limit"),
      request: request(),
      expect: { ok: false, failureCode: "RATE_LIMIT_TRANSIENT", nativeSessionId: SCRATCH_SESSION_ID },
    },
  ];
}
