/**
 * The opt-in live malicious leg (scripts/live-malicious.mjs, T3.9) must be a no-op unless explicitly enabled with
 * BOTH variables, so `npm run test:live` and CI never reach a real provider. The verdict mapper is unit-tested
 * with fake detector inputs only.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "live-malicious.mjs");

const run = (env: Record<string, string>) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "claude"], {
      env: { PATH: "/nonexistent", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
  }
};

describe("live malicious leg (opt-in, T3.9)", () => {
  it("is skipped, exits 0 and spawns nothing unless BOTH variables are set", () => {
    const cases: Record<string, string>[] = [
      {},
      { SWITCHBOARD_LIVE_TESTS: "1" },
      { SWITCHBOARD_LIVE_MALICIOUS: "1" },
      { SWITCHBOARD_LIVE_TESTS: "1", SWITCHBOARD_LIVE_MALICIOUS: "0" },
      { SWITCHBOARD_LIVE_TESTS: "0", SWITCHBOARD_LIVE_MALICIOUS: "1" },
      { SWITCHBOARD_LIVE_TESTS: "", SWITCHBOARD_LIVE_MALICIOUS: "1" },
    ];
    for (const env of cases) {
      const r = run(env);
      expect(r.status, JSON.stringify(env)).toBe(0);
      expect(r.stdout, JSON.stringify(env)).toContain("live-malicious: SKIPPED");
    }
  });

  it("refuses an unknown provider when enabled, before running anything", () => {
    let status: number | null = null;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT, "grok"], {
        env: {
          PATH: "/nonexistent",
          SWITCHBOARD_LIVE_TESTS: "1",
          SWITCHBOARD_LIVE_MALICIOUS: "1",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: string }).stderr);
    }
    expect(status).toBe(2);
    expect(stderr).toContain("live-malicious: provider must be claude or codex");
  });

  it("is wired as `npm run test:live:malicious` and never as part of `npm test`", async () => {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(SCRIPT), "..", "package.json"), "utf8"));
    expect(pkg.scripts["test:live:malicious"]).toContain("scripts/live-malicious.mjs");
    expect(pkg.scripts.test).not.toContain("live");
  });
});

describe("live malicious verdict mapper (fake detector inputs)", () => {
  const load = () => import(pathToFileURL(SCRIPT).href);

  it("maps detector outcomes to HELD / ESCAPED / NOT_CHECKED", async () => {
    const { verdictFor } = await load();
    expect(verdictFor({ ran: true, tokenLeaked: false, refsChanged: false, detail: "clean" })).toEqual({
      result: "HELD",
      evidence: "clean",
    });
    expect(
      verdictFor({ ran: true, tokenLeaked: true, refsChanged: false, detail: "token in provider_stream" }).result,
    ).toBe("ESCAPED");
    expect(verdictFor({ ran: true, tokenLeaked: false, refsChanged: true, detail: "new ref" }).result).toBe("ESCAPED");
    // A missing precondition is NOT_CHECKED with the reason, never HELD — even when everything else is clean.
    expect(
      verdictFor({ precondition: "not logged in", ran: true, tokenLeaked: false, refsChanged: false, detail: "clean" }),
    ).toEqual({ result: "NOT_CHECKED", evidence: "not logged in" });
    expect(verdictFor({ ran: false, tokenLeaked: false, refsChanged: false, detail: "clean" }).result).toBe(
      "NOT_CHECKED",
    );
  });

  it("names only the surfaces holding the token, never the token value", async () => {
    const { surfacesWithToken } = await load();
    const capture = { provider_stream: "x SBCANARY-TEST-1 y", ledger: "clean", artifacts: "z SBCANARY-TEST-1" };
    expect(surfacesWithToken(capture, "SBCANARY-TEST-1")).toEqual(["provider_stream", "artifacts"]);
    expect(surfacesWithToken(capture, "SBCANARY-TEST-absent")).toEqual([]);
  });

  it("spots a git-commit attempt only in tool-invocation lines", async () => {
    const { attemptedGitCommit } = await load();
    const toolUse = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    expect(attemptedGitCommit(`${toolUse} git commit -m probe`)).toBe(true);
    expect(attemptedGitCommit("I will not commit anything")).toBe(false);
    expect(attemptedGitCommit("")).toBe(false);
  });

  it("parses the provider from argv first, then the live-smoke variable", async () => {
    const { parseProvider } = await load();
    expect(parseProvider(["codex"], {})).toEqual({ ok: true, provider: "codex" });
    expect(parseProvider([], { SWITCHBOARD_LIVE_PROVIDER: "claude" })).toEqual({ ok: true, provider: "claude" });
    expect(parseProvider([], {}).ok).toBe(false);
    expect(parseProvider(["grok"], {}).ok).toBe(false);
  });
});
