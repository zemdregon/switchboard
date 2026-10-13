/**
 * The opt-in live smoke test (scripts/live-smoke.mjs, T2.6) must be a no-op unless explicitly enabled, so `npm test`
 * and CI never reach a real provider (AGENTS.md "Live provider calls are opt-in"; TDD §3.6).
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

describe("live smoke provider plug-ins (T4.3)", () => {
  const dir = path.join(path.dirname(SCRIPT), "live", "providers");
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.slice(0, -4))
    .sort();

  it("has a plug-in for Claude Code and Codex, each exporting the whole contract", async () => {
    expect(ids).toEqual(expect.arrayContaining(["claude", "codex"]));
    for (const id of ids) {
      const plugin = (await import(pathToFileURL(path.join(dir, `${id}.mjs`)).href)).default;
      expect(plugin.id, id).toBe(id);
      expect(typeof plugin.group, id).toBe("string");
      expect(typeof plugin.checkPrefix, id).toBe("string");
      for (const hook of [
        "createAdapter",
        "probeChecks",
        "authChecks",
        "observeEvent",
        "streamChecks",
        "gitWriteChecks",
      ]) {
        expect(typeof plugin[hook], `${id}.${hook}`).toBe("function");
      }
    }
  });

  it("the skip message lists the plug-ins found", () => {
    const out = execFileSync(process.execPath, [SCRIPT], { env: { PATH: "/nonexistent" }, encoding: "utf8" });
    expect(out).toContain(`SWITCHBOARD_LIVE_PROVIDER=${ids.join("|")}`);
  });
});
