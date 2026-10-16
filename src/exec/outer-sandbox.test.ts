/**
 * T3.1 (ADR-0051, LLD §8.4): outer-sandbox detection degrades to "unavailable" instead of crashing, and a profile that
 * `outer_sandbox.required_profiles` names is refused (ELIGIBILITY_NONE) whatever detection finds. The real-host probe
 * test is skipped when `bwrap` is not on PATH. The process-level refusal through `serve` is in src/cli/serve.test.ts.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toToolError } from "../mcp/errors.js";
import { createProfileResolver, ProfileUnavailableError } from "../policy/index.js";
import {
  BWRAP_PROBE_ARGS,
  describeOuterSandbox,
  detectOuterSandbox,
  findOnPath,
  type OuterSandboxAvailability,
  type OuterSandboxMechanismStatus,
  outerSandboxRefusal,
  PRLIMIT_PROBE_ARGS,
  wrapOuterSandboxVerification,
} from "./outer-sandbox.js";

const LSM_WITH = "lockdown,capability,landlock,yama,apparmor";
const LSM_WITHOUT = "lockdown,capability,yama,apparmor";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-outer-sandbox-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tool(name: string, body: string): void {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

const status = (mechanism: OuterSandboxMechanismStatus["mechanism"], available: boolean) => ({
  mechanism,
  available,
  path: null,
  version: null,
  detail: `${mechanism} ${available ? "ok" : "missing"}`,
});
const availability = (bubblewrap: boolean, prlimit: boolean, landlock = true): OuterSandboxAvailability => ({
  platform: "linux",
  mechanisms: {
    bubblewrap: status("bubblewrap", bubblewrap),
    prlimit: status("prlimit", prlimit),
    landlock: status("landlock", landlock),
  },
});

describe("detectOuterSandbox (T3.1)", () => {
  it("reports every mechanism unavailable off Linux without running anything", async () => {
    const calls: string[] = [];
    const a = await detectOuterSandbox({
      platform: "darwin",
      path: "/usr/bin:/bin",
      run: async (file) => {
        calls.push(file);
        return { code: 0, stdout: "", stderr: "" };
      },
      readLsmList: () => LSM_WITH,
    });
    expect(calls).toEqual([]);
    for (const m of ["bubblewrap", "prlimit", "landlock"] as const) {
      expect(a.mechanisms[m].available).toBe(false);
      expect(a.mechanisms[m].detail).toContain("darwin");
    }
  });

  it("degrades to unavailable when the tools are not on PATH and the LSM list cannot be read", async () => {
    const a = await detectOuterSandbox({
      platform: "linux",
      path: dir,
      readLsmList: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });
    expect(a.mechanisms.bubblewrap).toMatchObject({ available: false, path: null, detail: "bwrap not found on PATH" });
    expect(a.mechanisms.prlimit).toMatchObject({ available: false, detail: "prlimit not found on PATH" });
    expect(a.mechanisms.landlock.available).toBe(false);
    expect(a.mechanisms.landlock.detail).toContain("EACCES");
  });

  it("an empty or relative PATH finds nothing", async () => {
    tool("bwrap", "exit 0");
    expect(findOnPath("bwrap", "")).toBeNull();
    expect(findOnPath("bwrap", undefined)).toBeNull();
    expect(findOnPath("bwrap", path.relative(process.cwd(), dir))).toBeNull();
    expect(findOnPath("bwrap", dir)).toBe(path.join(dir, "bwrap"));
  });

  it("an installed bwrap whose namespace probe fails is unavailable, with its version and stderr", async () => {
    tool(
      "bwrap",
      'if [ "$1" = --version ]; then echo "bubblewrap 0.0.1"; exit 0; fi\necho "setting up uid map: Permission denied" >&2; exit 1',
    );
    tool("prlimit", 'if [ "$1" = --version ]; then echo "prlimit from util-linux 9.9"; exit 0; fi\nshift 2\nexec "$@"');
    const a = await detectOuterSandbox({
      platform: "linux",
      path: `${dir}:/usr/bin:/bin`,
      readLsmList: () => LSM_WITH,
    });
    expect(a.mechanisms.bubblewrap).toMatchObject({
      available: false,
      version: "0.0.1",
      path: path.join(dir, "bwrap"),
    });
    expect(a.mechanisms.bubblewrap.detail).toContain("exited 1: setting up uid map: Permission denied");
    expect(a.mechanisms.prlimit).toMatchObject({ available: true, version: "9.9", path: path.join(dir, "prlimit") });
  });

  it("passes the documented probe arguments and reports a probe that cannot start or throws", async () => {
    tool("bwrap", "exit 0");
    tool("prlimit", "exit 0");
    const seen: [string, readonly string[]][] = [];
    const a = await detectOuterSandbox({
      platform: "linux",
      path: dir,
      run: async (file, args) => {
        seen.push([path.basename(file), args]);
        if (path.basename(file) === "prlimit" && args[0] !== "--version") throw new Error("spawn EPERM");
        return args[0] === "--version" ? { code: 0, stdout: "", stderr: "" } : { code: null, stdout: "", stderr: "" };
      },
      readLsmList: () => LSM_WITHOUT,
    });
    expect(seen).toContainEqual(["bwrap", BWRAP_PROBE_ARGS]);
    expect(seen).toContainEqual(["prlimit", PRLIMIT_PROBE_ARGS]);
    expect(a.mechanisms.bubblewrap.available).toBe(false);
    expect(a.mechanisms.bubblewrap.detail).toContain("did not complete");
    expect(a.mechanisms.prlimit).toMatchObject({ available: false, detail: "probe error: spawn EPERM" });
    expect(a.mechanisms.landlock).toMatchObject({ available: false, version: null });
  });

  it("Landlock is available only when the active LSM list names it; its ABI version is never guessed", async () => {
    const on = await detectOuterSandbox({ platform: "linux", path: dir, readLsmList: () => `${LSM_WITH}\n` });
    expect(on.mechanisms.landlock).toMatchObject({ available: true, version: null });
    expect(on.mechanisms.landlock.detail).toContain("ABI version not determined");
    const off = await detectOuterSandbox({ platform: "linux", path: dir, readLsmList: () => LSM_WITHOUT });
    expect(off.mechanisms.landlock.available).toBe(false);
    expect(describeOuterSandbox(off)).toMatch(
      /^bubblewrap: unavailable .*; prlimit: unavailable .*; landlock: unavailable/,
    );
  });

  describe.skipIf(findOnPath("bwrap", process.env.PATH) === null)("on this host (bwrap on PATH)", () => {
    it("runs the real bubblewrap probe and never throws", async () => {
      const a = await detectOuterSandbox();
      const b = a.mechanisms.bubblewrap;
      expect(b.path).toBe(findOnPath("bwrap", process.env.PATH));
      // Usable or not depends on the host's user-namespace policy; either way the result says which and why.
      if (b.available) expect(b.detail).toContain("probe ran");
      else expect(b.detail).toMatch(/probe (exited|did not complete)/);
    });
  });
});

describe("outerSandboxRefusal (T3.1, fail closed)", () => {
  it("leaves a profile that is not listed alone", () => {
    expect(outerSandboxRefusal("edit-untrusted", [], availability(false, false))).toBeUndefined();
    expect(outerSandboxRefusal("edit-untrusted", ["test-sandboxed"], availability(false, false))).toBeUndefined();
  });

  it("refuses a listed profile when a required mechanism is missing, naming it", () => {
    const r = outerSandboxRefusal("test-sandboxed", ["test-sandboxed"], availability(true, false));
    expect(r?.reason).toBe("OUTER_SANDBOX_UNAVAILABLE");
    expect(r?.message).toContain("lacks prlimit (prlimit missing)");
    expect(r?.message).not.toContain("lacks bubblewrap");
    expect(outerSandboxRefusal("test-sandboxed", ["test-sandboxed"], undefined)?.reason).toBe(
      "OUTER_SANDBOX_UNAVAILABLE",
    );
  });

  it("still refuses a listed profile when every mechanism is present, because no run is wrapped yet", () => {
    const r = outerSandboxRefusal("edit-untrusted", ["edit-untrusted"], availability(true, true, false));
    expect(r?.reason).toBe("OUTER_SANDBOX_NOT_ENFORCED");
    expect(r?.message).toContain("does not yet wrap runs");
  });

  it("a configured-but-missing sandbox refuses at the profile resolver with ELIGIBILITY_NONE, not an unconfined run", () => {
    const missing = availability(false, false, false);
    const resolve = createProfileResolver({}, (p) => outerSandboxRefusal(p, ["edit-untrusted"], missing)?.message);
    expect(resolve("inspect-untrusted").name).toBe("inspect-untrusted");
    let thrown: unknown;
    try {
      resolve("edit-untrusted");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProfileUnavailableError);
    expect((thrown as ProfileUnavailableError).code).toBe("ELIGIBILITY_NONE");
    const tool = toToolError(thrown);
    expect(tool.code).toBe("ELIGIBILITY_NONE");
    expect(tool.message).toContain("OUTER_SANDBOX_UNAVAILABLE");
    expect(tool.details).toEqual({ trust_profile: "edit-untrusted" });
  });
});

describe("wrapOuterSandboxVerification (T3.11)", () => {
  it("builds the bubblewrap argument array with read-only root, dev, proc, worktree bind, chdir, and unshare", () => {
    const wrapped = wrapOuterSandboxVerification("/usr/bin/bwrap", dir, ["npm", "test"]);
    const canonical = realpathSync(dir);
    expect(wrapped).toEqual([
      "/usr/bin/bwrap",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      canonical,
      canonical,
      "--chdir",
      canonical,
      "--unshare-all",
      "--die-with-parent",
      "--",
      "npm",
      "test",
    ]);
  });

  it("resolves symlinked worktree directories to their canonical path for binding and chdir", () => {
    const symlinkPath = path.join(dir, "symlink-wt");
    const targetDir = path.join(dir, "real-wt");
    chmodSync(dir, 0o777);
    mkdirSync(targetDir);
    symlinkSync(targetDir, symlinkPath);

    const wrapped = wrapOuterSandboxVerification("/usr/bin/bwrap", symlinkPath, ["node", "-v"]);
    const canonical = realpathSync(targetDir);
    expect(wrapped[9]).toBe(canonical);
    expect(wrapped[10]).toBe(canonical);
    expect(wrapped[12]).toBe(canonical);
    expect(wrapped.slice(-3)).toEqual(["--", "node", "-v"]);
  });
});
