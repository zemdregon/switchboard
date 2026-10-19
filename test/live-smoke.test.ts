/**
 * The opt-in live smoke test (scripts/live-smoke.mjs, T2.6) must be a no-op unless explicitly enabled, so `npm test`
 * and CI never reach a real provider (AGENTS.md "Live provider calls are opt-in"; TDD §3.6).
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createParseState } from "../src/adapters/types.js";
import { compileCell } from "./live-cells.js";

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
        env: { PATH: "/nonexistent", SWITCHBOARD_LIVE_TESTS: "1", SWITCHBOARD_LIVE_PROVIDER: "nope" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: string }).stderr);
    }
    expect(status).toBe(2);
    expect(stderr).toContain(
      "SWITCHBOARD_LIVE_PROVIDER must be one of agy, claude, codex, cursor, grok, kimi, opencode",
    );
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

  it("has a plug-in for Antigravity, OpenCode, Cursor, Kimi Code and Grok Build, each with an approved smoke cell", async () => {
    expect(ids).toEqual(expect.arrayContaining(["agy", "opencode", "cursor", "kimi", "grok"]));
    const adapterOf: Record<string, string> = { agy: "antigravity" };
    for (const id of ["agy", "opencode", "cursor", "kimi", "grok"]) {
      const plugin = (await import(pathToFileURL(path.join(dir, `${id}.mjs`)).href)).default;
      expect(plugin.adapterId ?? id, id).toBe(adapterOf[id] ?? id);
      expect(plugin.smokeCell.scope.files.access, id).toBe("worktree");
      // Every smoke check id starts with the plug-in's prefix; none collides with the shared flow's G-1 or E2E.
      expect(plugin.checkPrefix, id).toMatch(/^[A-Z]+$/);
      expect(plugin.checkPrefix, id).not.toBe("G");
    }
  });

  it("compiles every smoke cell in its adapter with exactly the cell's declared bypass-class flag", async () => {
    const want: Record<string, { transport: string; flags: string[] }> = {
      agy: { transport: "subprocess-jsonl", flags: ["--dangerously-skip-permissions"] },
      cursor: { transport: "subprocess-jsonl", flags: ["--force"] },
      grok: { transport: "subprocess-jsonl", flags: ["--always-approve"] },
      kimi: { transport: "acp-stdio", flags: [] },
      opencode: { transport: "subprocess-jsonl", flags: [] },
    };
    for (const [id, w] of Object.entries(want)) {
      const plugin = (await import(pathToFileURL(path.join(dir, `${id}.mjs`)).href)).default;
      const { result, bypassFlags } = compileCell(plugin.adapterId ?? id, plugin.smokeCell.scope);
      expect("reason" in result ? `${result.reason}: ${result.detail}` : result.transport, id).toBe(w.transport);
      expect(bypassFlags, id).toEqual(w.flags);
      expect(plugin.smokeCell.bypassFlag ?? null, id).toBe(w.flags[0] ?? null);
    }
  });

  it("Kimi's parseLine skips ACP control-plane messages and passes stream records to the adapter", async () => {
    const kimi = (await import(pathToFileURL(path.join(dir, "kimi.mjs")).href)).default;
    const seen: unknown[] = [];
    const adapter = {
      parseEvent: (input: unknown) => {
        seen.push(input);
        return [{ kind: "message" }];
      },
    };
    const state = createParseState();
    const rpc = (o: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...o });
    expect(kimi.parseLine(adapter, rpc({ id: 1, result: { protocolVersion: 1 } }), state)).toEqual([]);
    expect(kimi.parseLine(adapter, rpc({ id: 9, method: "session/request_permission", params: {} }), state)).toEqual(
      [],
    );
    expect(seen).toEqual([]);
    const update = { jsonrpc: "2.0", method: "session/update", params: { update: {} } };
    expect(kimi.parseLine(adapter, JSON.stringify(update), state)).toHaveLength(1);
    const end = { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } };
    expect(kimi.parseLine(adapter, JSON.stringify(end), state)).toHaveLength(1);
    const streamJson = JSON.stringify({ role: "assistant", content: "ok" });
    expect(kimi.parseLine(adapter, streamJson, state)).toHaveLength(1);
    expect(seen).toEqual([update, end, streamJson]);
  });

  it("the shared stream checks read the adapter's normalized kinds (fake context, no CLI)", async () => {
    const opencode = (await import(pathToFileURL(path.join(dir, "opencode.mjs")).href)).default;
    const rows: { id: string; result: string }[] = [];
    const record = (id: string, _g: string, _a: string, result: string) => rows.push({ id, result });
    const held = (ok: boolean | undefined) => (ok === undefined ? "NOT_CHECKED" : ok ? "HELD" : "FAILED");
    const base = { record, held, final: { status: "SUCCEEDED" }, badJson: 0, smokeContent: "ok" };
    opencode.streamChecks({
      ...base,
      ran: true,
      succeeded: true,
      kinds: new Map([
        ["session_bound", 1],
        ["result", 1],
        ["tool_call", 1],
      ]),
      unknownEvents: 0,
      toolNames: new Set(["write"]),
    });
    expect(rows.map((r) => `${r.id}:${r.result}`)).toEqual([
      "O-4:HELD",
      "O-5:HELD",
      "O-6:HELD",
      "O-7:HELD",
      "O-8:HELD",
    ]);
    rows.length = 0;
    opencode.streamChecks({
      ...base,
      ran: true,
      succeeded: false,
      kinds: new Map(),
      unknownEvents: 2,
      toolNames: new Set(),
    });
    expect(rows.map((r) => r.result)).toEqual(["FAILED", "FAILED", "FAILED", "FAILED", "FAILED"]);
    rows.length = 0;
    opencode.streamChecks({
      ...base,
      ran: false,
      succeeded: false,
      kinds: new Map(),
      unknownEvents: 0,
      toolNames: new Set(),
    });
    expect(new Set(rows.map((r) => r.result))).toEqual(new Set(["NOT_CHECKED"]));
  });

  it("the skip message lists the plug-ins found, except the fake fixture (T8.9)", () => {
    const out = execFileSync(process.execPath, [SCRIPT], { env: { PATH: "/nonexistent" }, encoding: "utf8" });
    expect(out).toContain(`SWITCHBOARD_LIVE_PROVIDER=${ids.filter((id) => !id.startsWith("fake")).join("|")} `);
  });
});

describe("live pair script (opt-in, T5.11)", () => {
  const PAIR = path.join(path.dirname(SCRIPT), "live-pair.mjs");
  const providers = path.join(path.dirname(SCRIPT), "live", "providers");
  const run = (env: Record<string, string>) => {
    try {
      const stdout = execFileSync(process.execPath, [PAIR], {
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

  it("is skipped, exits 0 and runs nothing unless SWITCHBOARD_LIVE_TESTS=1", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const env: Record<string, string> = { SWITCHBOARD_LIVE_PAIR: "claude:codex" };
      if (value !== undefined) env.SWITCHBOARD_LIVE_TESTS = value;
      const r = run(env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("live-pair: SKIPPED");
    }
  });

  it("refuses a malformed, identical or unknown pair when enabled, before running anything", () => {
    for (const spec of ["claude", "claude:claude", "claude:nope", "claude:codex:grok", "CLAUDE:codex"]) {
      const r = run({ SWITCHBOARD_LIVE_TESTS: "1", SWITCHBOARD_LIVE_PAIR: spec });
      expect(r.status, spec).toBe(2);
      expect(r.stderr, spec).toContain("live-pair:");
    }
  });

  it("parses the pair spec: both directions by default, one pair when named", async () => {
    const { parsePairs } = await import(pathToFileURL(PAIR).href);
    expect(parsePairs(undefined)).toEqual({
      ok: true,
      pairs: [
        ["claude", "codex"],
        ["codex", "claude"],
      ],
    });
    expect(parsePairs("both")).toEqual(parsePairs(undefined));
    expect(parsePairs("codex:claude")).toEqual({ ok: true, pairs: [["codex", "claude"]] });
    expect(parsePairs("claude:claude").ok).toBe(false);
    expect(parsePairs("claude:fake-x").ok).toBe(false);
  });

  it("every provider of the default pairs has a plug-in exporting the whole contract", async () => {
    const { parsePairs } = await import(pathToFileURL(PAIR).href);
    const parsed = parsePairs(undefined);
    const ids = [...new Set(parsed.pairs.flat() as string[])];
    expect(ids.sort()).toEqual(["claude", "codex"]);
    for (const id of ids) {
      expect(readdirSync(providers)).toContain(`${id}.mjs`);
      const plugin = (await import(pathToFileURL(path.join(providers, `${id}.mjs`)).href)).default;
      for (const hook of ["createAdapter", "probeChecks", "authChecks"]) {
        expect(typeof plugin[hook], `${id}.${hook}`).toBe("function");
      }
    }
  });

  it("is wired as `npm run test:live:pair` and never as part of `npm test`", async () => {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(SCRIPT), "..", "package.json"), "utf8"));
    expect(pkg.scripts["test:live:pair"]).toContain("scripts/live-pair.mjs");
    expect(pkg.scripts.test).not.toContain("live");
  });
});
