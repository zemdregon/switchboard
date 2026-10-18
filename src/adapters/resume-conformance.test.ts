/**
 * T5.8 (FR-SES-03, FR-ADP-04, FR-ADP-11, NFR-MAINT-01; TDD §4.9 item 6): a registry-wide check of `resumeArgs`.
 * It enumerates every provider entry that has an adapter (the built-ins, plus the second continuity fake and the T4.1
 * scratch adapter registered at runtime, T4.2) and requires each adapter to:
 *
 * 1. declare `resumeCwd` as the value of its registry entry, one of `bound`, `independent` or `unverified` (T5.7);
 * 2. compile a binding of its own provider wherever `compile` compiles the same request and profile, or return an
 *    `Ineligible` that carries a reason (never throw, never an empty reason);
 * 3. reject a binding of any other provider with `Ineligible`, naming a reason;
 * 4. carry the request through: the resume invocation runs in the request's working directory, has the native session
 *    id as one whole argv word and is not the fresh compile's argv.
 *
 * A deliberately broken adapter must fail the same check, so the check itself cannot silently pass. No provider CLI is
 * run: Claude Code and Codex are given synthetic executable paths and compile is pure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../policy/profiles.js";
import { ClaudeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { secondFakeProvider } from "./fixtures/continuity-fakes.js";
import { SCRATCH_PROVIDER } from "./fixtures/scratch-provider.js";
import { type ProviderEntry, providerEntries, registerProvider } from "./providers.js";
import {
  type CompileRequest,
  isIneligible,
  type NativeBinding,
  type ProviderAdapter,
  type ProviderId,
  type ResolvedProfile,
} from "./types.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const REQUEST: CompileRequest = {
  runId: "run_resume_conformance",
  objective: "continue the task",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
};
const PROFILES: readonly ResolvedProfile[] = (
  ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const
).map((name) => resolveTrustProfile(name));
const RESUME_CWD_VALUES: readonly unknown[] = ["bound", "independent", "unverified"];

/** An adapter for an entry; Claude Code and Codex get synthetic executables so `compile` can succeed (never run). */
function adapterFor(entry: ProviderEntry): ProviderAdapter | undefined {
  if (entry.id === "claude") return new ClaudeAdapter({ binaryPath: "/opt/synthetic/bin/claude" });
  if (entry.id === "codex") return new CodexAdapter({ executable: "/opt/synthetic/bin/codex" });
  return entry.create?.({});
}

/** Every violation of the T5.8 contract for one adapter; empty when it conforms. */
function resumeViolations(
  entry: ProviderEntry,
  adapter: ProviderAdapter,
  otherIds: readonly string[],
  profiles: readonly ResolvedProfile[] = PROFILES,
): string[] {
  const out: string[] = [];
  const id = entry.id;
  if (!RESUME_CWD_VALUES.includes(adapter.resumeCwd)) out.push(`${id}: resumeCwd is ${String(adapter.resumeCwd)}`);
  if (adapter.resumeCwd !== entry.resumeCwd) out.push(`${id}: resumeCwd differs from its registry entry`);
  const own: NativeBinding = { provider: id as ProviderId, nativeSessionId: SESSION };
  for (const profile of profiles) {
    const where = `${id}/${profile.name}`;
    const fresh = adapter.compile(REQUEST, profile);
    let resumed: ReturnType<ProviderAdapter["resumeArgs"]>;
    try {
      resumed = adapter.resumeArgs(own, REQUEST, profile);
    } catch (err) {
      out.push(`${where}: resumeArgs threw ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (isIneligible(resumed)) {
      if (!isIneligible(fresh)) out.push(`${where}: compile compiles but resumeArgs is Ineligible (${resumed.reason})`);
      if (resumed.detail.trim() === "") out.push(`${where}: Ineligible without a reason`);
    } else {
      if (isIneligible(fresh)) out.push(`${where}: resumeArgs compiles where compile is Ineligible (${fresh.reason})`);
      if (resumed.cwd !== REQUEST.workspace.cwd) out.push(`${where}: resume cwd is ${String(resumed.cwd)}`);
      if (!resumed.argv.includes(SESSION)) out.push(`${where}: argv does not carry the native session id`);
      if (!isIneligible(fresh) && JSON.stringify(fresh.argv) === JSON.stringify(resumed.argv)) {
        out.push(`${where}: resume argv equals the fresh compile argv`);
      }
    }
  }
  const [profile] = profiles;
  if (profile === undefined) return out;
  for (const other of [...otherIds, "no-such-provider"]) {
    let foreign: ReturnType<ProviderAdapter["resumeArgs"]>;
    try {
      foreign = adapter.resumeArgs({ provider: other as ProviderId, nativeSessionId: SESSION }, REQUEST, profile);
    } catch (err) {
      out.push(`${id}: resumeArgs threw ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isIneligible(foreign)) out.push(`${id}: accepted a binding for ${other}`);
    else if (foreign.detail.trim() === "") out.push(`${id}: refused a binding for ${other} without a reason`);
  }
  return out;
}

let unregister: (() => void)[] = [];
beforeEach(() => {
  unregister = [registerProvider(secondFakeProvider("/nonexistent-home")), registerProvider(SCRATCH_PROVIDER)];
});
afterEach(() => {
  for (const off of unregister) off();
});

const adapters = () =>
  providerEntries().flatMap((entry) => {
    const adapter = adapterFor(entry);
    return adapter === undefined ? [] : [{ entry, adapter }];
  });

describe("resumeArgs conformance over the provider registry (T5.8)", () => {
  it("enumerates Claude Code, Codex, both fakes and the scratch adapter", () => {
    const ids = adapters().map((a) => a.entry.id);
    expect(ids).toEqual(expect.arrayContaining(["claude", "codex", "fake", "fake-b", "scratch"]));
  });

  it("every registered adapter conforms", () => {
    const all = adapters();
    const ids = all.map((a) => a.entry.id);
    const violations = all.flatMap(({ entry, adapter }) =>
      resumeViolations(
        entry,
        adapter,
        ids.filter((i) => i !== entry.id),
      ),
    );
    expect(violations).toEqual([]);
  });

  it("the check sees compiled resumes, not only refusals (Claude Code and Codex compile with an executable)", () => {
    for (const id of ["claude", "codex"]) {
      const found = adapters().find((a) => a.entry.id === id);
      if (!found) throw new Error(`${id} missing`);
      const profile = PROFILES.find((p) => p.name === "edit-untrusted");
      if (!profile) throw new Error("no profile");
      const r = found.adapter.resumeArgs({ provider: id as ProviderId, nativeSessionId: SESSION }, REQUEST, profile);
      expect(isIneligible(r), `${id}: ${isIneligible(r) ? r.detail : ""}`).toBe(false);
    }
  });

  describe("a deliberately broken adapter fails the check", () => {
    const fake = () => {
      const found = adapters().find((a) => a.entry.id === "fake");
      if (!found) throw new Error("fake missing");
      return found;
    };
    /** The fake adapter with one method or declaration replaced. */
    const broken = (patch: Partial<Record<keyof ProviderAdapter, unknown>>): ProviderAdapter => {
      const base = fake().adapter;
      const delegate = {
        id: base.id,
        resumeCwd: base.resumeCwd,
        compile: (r: CompileRequest, p: ResolvedProfile) => base.compile(r, p),
        resumeArgs: (b: NativeBinding, r: CompileRequest, p: ResolvedProfile) => base.resumeArgs(b, r, p),
      };
      return { ...delegate, ...patch } as unknown as ProviderAdapter;
    };
    const check = (adapter: ProviderAdapter) => resumeViolations(fake().entry, adapter, ["claude", "codex"]);

    it("passes unmodified (control)", () => {
      expect(check(fake().adapter)).toEqual([]);
    });

    it("accepts another provider's binding", () => {
      const base = fake().adapter;
      const bad = broken({
        resumeArgs: (b: NativeBinding, r: CompileRequest, p: ResolvedProfile) =>
          base.resumeArgs({ ...b, provider: "fake" as ProviderId }, r, p),
      });
      expect(check(bad).join("\n")).toContain("accepted a binding for claude");
    });

    it("is Ineligible to resume where it compiles", () => {
      const bad = broken({
        resumeArgs: () => ({ ineligible: true, reason: "CAPABILITY_MISSING", detail: "no resume" }),
      });
      expect(check(bad).join("\n")).toContain("compile compiles but resumeArgs is Ineligible");
    });

    it("gives no reason, changes directory or drops the session id", () => {
      const base = fake().adapter;
      const noReason = broken({
        resumeArgs: () => ({ ineligible: true, reason: "CAPABILITY_MISSING", detail: "" }),
        compile: () => ({ ineligible: true, reason: "CAPABILITY_MISSING", detail: "x" }),
      });
      expect(check(noReason).join("\n")).toContain("Ineligible without a reason");
      const elsewhere = broken({
        resumeArgs: (b: NativeBinding, r: CompileRequest, p: ResolvedProfile) =>
          base.resumeArgs(b, { ...r, workspace: { ...r.workspace, cwd: "/elsewhere" } }, p),
      });
      expect(check(elsewhere).join("\n")).toContain("resume cwd is /elsewhere");
      const dropped = broken({
        resumeArgs: (_b: NativeBinding, r: CompileRequest, p: ResolvedProfile) => base.compile(r, p),
      });
      expect(check(dropped).join("\n")).toContain("does not carry the native session id");
    });

    it("lacks the resumeCwd declaration", () => {
      expect(check(broken({ resumeCwd: undefined })).join("\n")).toContain("resumeCwd is undefined");
      expect(check(broken({ resumeCwd: "maybe" })).join("\n")).toContain("resumeCwd is maybe");
    });

    it("throws instead of refusing", () => {
      const bad = broken({
        resumeArgs: () => {
          throw new Error("boom");
        },
      });
      expect(check(bad).join("\n")).toContain("resumeArgs threw boom");
    });
  });
});
