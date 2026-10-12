/**
 * The opt-in live smoke test (scripts/live-smoke.mjs, T2.6) must be a no-op unless explicitly enabled, so `npm test`
 * and CI never reach a real provider (AGENTS.md "Live provider calls are opt-in"; TDD §3.6).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "live-smoke.mjs");

describe("live smoke script (opt-in)", () => {
  it("is skipped, exits 0 and runs nothing unless SWITCHBOARD_LIVE_TESTS=1", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const env: Record<string, string> = { PATH: "/nonexistent", SWITCHBOARD_LIVE_PROVIDER: "claude" };
      if (value !== undefined) env.SWITCHBOARD_LIVE_TESTS = value;
      const out = execFileSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
      expect(out).toContain("live-smoke: SKIPPED");
    }
  });

  it("refuses an unknown provider when enabled, before running anything", () => {
    let status: number | null = null;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT], {
        env: { PATH: "/nonexistent", SWITCHBOARD_LIVE_TESTS: "1", SWITCHBOARD_LIVE_PROVIDER: "grok" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: string }).stderr);
    }
    expect(status).toBe(2);
    expect(stderr).toContain("SWITCHBOARD_LIVE_PROVIDER must be one of claude, codex");
  });
});
