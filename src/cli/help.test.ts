import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_HELP, commandNames, renderCommandHelp } from "./help.js";
import { HELP, main, runCli } from "./index.js";
import type { CliIo } from "./io.js";

function makeIo(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
    ...extra,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const h = makeIo(extra);
  const code = await main(args, h.io);
  return { code, out: h.out(), err: h.err() };
}

/** Top-level `case "<cmd>":` lines of the `switch (cmd)` in main.ts (6-space indent, no nested switch). */
function mainSwitchCommands(): string[] {
  const src = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  return [...src.matchAll(/^ {6}case "([a-z-]+)":/gm)].map((m) => m[1] as string);
}

describe("per-command help table", () => {
  it("covers every command in main's switch, and nothing else", () => {
    expect([...commandNames()].sort()).toEqual([...new Set(mainSwitchCommands())].sort());
  });

  it("renders usage, options and one example for every command, via --help, -h and help <command>", async () => {
    expect(COMMAND_HELP.length).toBeGreaterThan(0);
    for (const entry of COMMAND_HELP) {
      for (const args of [
        [entry.name, "--help"],
        [entry.name, "-h"],
        ["help", entry.name],
      ]) {
        const r = await run(args);
        expect(r.code, args.join(" ")).toBe(0);
        expect(r.out, args.join(" ")).toBe(renderCommandHelp(entry.name));
        expect(r.out).toContain("Usage:");
        expect(r.out).toContain(entry.example);
        for (const line of entry.usage) expect(r.out).toContain(line);
        for (const line of entry.options) expect(r.out).toContain(line);
        expect(r.out).toContain(entry.summary);
      }
      expect(renderCommandHelp(entry.name)).toContain(`Example:\n  ${entry.example}\n`);
    }
  });

  it("keeps tool-shim hidden from help", () => {
    expect(commandNames()).not.toContain("tool-shim");
    expect(renderCommandHelp("tool-shim")).toBeUndefined();
    expect(HELP).not.toContain("tool-shim");
  });
});

describe("help before option validation", () => {
  it("prints the command help instead of a usage error for invalid options", async () => {
    const cases: [string[], string][] = [
      [["runs", "--apply", "--help"], "runs"],
      [["runs", "list", "--bogus", "--help"], "runs"],
      [["--help", "runs"], "runs"],
      [["gc", "--provider", "x", "--help"], "gc"],
    ];
    for (const [args, name] of cases) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out, args.join(" ")).toBe(renderCommandHelp(name));
    }
  });

  it("still prints the global help for bare --help, -h and help", async () => {
    for (const args of [["--help"], ["-h"], ["help"], ["help", "--help"]]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out, args.join(" ")).toBe(HELP);
    }
  });

  it("reports a usage error listing commands for help <unknown>", async () => {
    for (const args of [
      ["help", "frobnicate"],
      ["frobnicate", "--help"],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err, args.join(" ")).toContain('unknown help topic "frobnicate"');
      for (const name of commandNames()) expect(r.err).toContain(name);
      expect(r.err).toContain("Run 'switchboard --help' for usage.");
    }
    const j = await run(["help", "frobnicate", "--json"]);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.out).error.code).toBe("USAGE");
  });
});

describe("JSON parse error message", () => {
  it("says what failed to parse and clips the reason to 200 chars", async () => {
    const r = await run(["schedule", "create", "* * * * *", "proj", "{bad"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid JSON in template: ");
    expect(r.err).not.toContain("SyntaxError");
    expect(r.err).toContain("Run 'switchboard --help' for usage.");

    vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw new Error("x".repeat(500));
    });
    try {
      const clipped = await run(["schedule", "create", "* * * * *", "proj", "{}"]);
      expect(clipped.code).toBe(2);
      const reason = clipped.err.split("invalid JSON in template: ")[1]?.split("\n")[0] ?? "";
      expect(reason).toBe("x".repeat(200));
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("runCli guard (bin.ts)", () => {
  it("passes through the exit code when main does not throw", async () => {
    const h = makeIo();
    expect(await runCli(["--help"], h.io, async () => 42)).toBe(42);
    expect(h.err()).toBe("");
  });

  it("prints switchboard: <message> with exit 1 and no stack when main throws", async () => {
    const throwing = async () => {
      throw new Error("boom");
    };
    const h = makeIo();
    expect(await runCli([], h.io, throwing)).toBe(1);
    expect(h.err()).toBe("switchboard: boom\n");

    const odd = async (): Promise<number> => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "plain string failure";
    };
    const h2 = makeIo();
    expect(await runCli([], h2.io, odd)).toBe(1);
    expect(h2.err()).toBe("switchboard: plain string failure\n");
  });

  it("prints the stack only with SWITCHBOARD_DEBUG=1", async () => {
    const throwing = async (): Promise<number> => {
      throw new Error("boom");
    };
    const h = makeIo({ env: { SWITCHBOARD_DEBUG: "1" } });
    expect(await runCli([], h.io, throwing)).toBe(1);
    expect(h.err()).toContain("switchboard: Error: boom\n");
    expect(h.err()).toMatch(/at /);
  });
});
