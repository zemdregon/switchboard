/**
 * T4.68 bypass-only gate (owner ruling relayed 2026-10-19 08:45 CDT, "T4.68 KIMI BYPASS-ONLY"; Delegated reading):
 * only an approved privileged bypass run compiles for Kimi Code; every other mode is Ineligible before any invocation
 * exists. HERMETIC: no `kimi` binary is run; the marker-file script proves nothing is spawned.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { privilegedProfile } from "../fixtures/privileged.js";
import type { CompileRequest } from "../types.js";
import { isIneligible } from "../types.js";
import { KIMI_NO_PERMISSION_REQUESTS, KimiAdapter, kimiBypassOnlyGate } from "./adapter.js";

const PHRASE = "Kimi has no permission requests";
const SESSION = "session_00000000-0000-0000-0000-000000000001";
const binding = { provider: "kimi", nativeSessionId: SESSION } as const;
const dir = mkdtempSync(join(tmpdir(), "sb-kimi-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: "fix the failing test",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;
const APPROVAL_SCOPES = {
  worktree: { ...BYPASS_SCOPE, bypass: false },
  "read-only": { ...BYPASS_SCOPE, files: { access: "read-only" }, bypass: false },
} as const;

const expectRefused = (r: unknown, mode?: string): void => {
  expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: expect.stringContaining(PHRASE) });
  if (mode !== undefined) expect(r).toMatchObject({ detail: expect.stringContaining(`mode ${mode}`) });
};

describe("kimi bypass-only gate (T4.68 ruling 2026-10-19 08:45 CDT)", () => {
  it("bypass passes the gate, and an approved privileged bypass scope compiles the --prompt subprocess cell", () => {
    expect(kimiBypassOnlyGate("bypass")).toBeUndefined();
    const adapter = new KimiAdapter({ executable: "/opt/synthetic/kimi" });
    const r = adapter.compile(request({ bypassApproved: true }), {
      ...privilegedProfile(BYPASS_SCOPE),
      bypassApproved: true,
    });
    if (isIneligible(r)) throw new Error(`expected an invocation: ${r.detail}`);
    expect(r.transport).toBe("subprocess-jsonl");
    expect(r.argv.some((a) => a.startsWith("--prompt="))).toBe(true);
  });

  it("interactive mode is refused by name", () => {
    const r = kimiBypassOnlyGate("interactive");
    expectRefused(r, "interactive");
    expect(r?.detail).toContain(KIMI_NO_PERMISSION_REQUESTS);
  });

  it("approval mode is refused, and a privileged scope without bypass is refused at compile and at resume", () => {
    expectRefused(kimiBypassOnlyGate("approval"), "approval");
    const adapter = new KimiAdapter({ executable: "/opt/synthetic/kimi" });
    for (const scope of Object.values(APPROVAL_SCOPES)) {
      const profile = privilegedProfile(scope);
      for (const approved of [false, true]) {
        const req = request({ bypassApproved: approved });
        const p = { ...profile, bypassApproved: approved };
        expectRefused(adapter.compile(req, p));
        expectRefused(adapter.resumeArgs(binding, req, p));
      }
    }
  });

  it.each([
    ["undefined", undefined, "missing"],
    ["null", null, "missing"],
    ["empty string", "", "missing"],
    ["yolo", "yolo", "yolo"],
    ["auto", "auto", "auto"],
    ["BYPASS (case differs)", "BYPASS", "BYPASS"],
    ["number", 1, "missing"],
    ["object", {}, "missing"],
  ])("an unknown or missing mode (%s) is refused", (_name, mode, label) => {
    expectRefused(kimiBypassOnlyGate(mode), label);
  });

  it("refusal happens before any spawn: no invocation, and the executable's marker file is never written", () => {
    const marker = join(dir, "marker");
    const script = join(dir, "fake-kimi.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(script, 0o755);
    const adapter = new KimiAdapter({ executable: script });
    for (const scope of Object.values(APPROVAL_SCOPES)) {
      const profile = privilegedProfile(scope);
      const r = adapter.compile(request(), profile);
      expect(isIneligible(r)).toBe(true);
      expect("argv" in (r as object)).toBe(false); // no argv exists to spawn
      expectRefused(adapter.resumeArgs(binding, request(), profile));
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("the gate is ahead of the binary check: with no kimi on PATH the refusal is the gate's, not 'not found on PATH'", () => {
    const adapter = new KimiAdapter({ pathEnv: "" });
    const r = adapter.compile(request(), privilegedProfile(APPROVAL_SCOPES.worktree));
    expectRefused(r);
    expect((r as { detail: string }).detail).not.toContain("not found on PATH");
    // Control: the approved bypass scope with the same missing binary is the binary refusal.
    const bypass = adapter.compile(request({ bypassApproved: true }), {
      ...privilegedProfile(BYPASS_SCOPE),
      bypassApproved: true,
    });
    expect(bypass).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("not found on PATH"),
    });
  });
});
