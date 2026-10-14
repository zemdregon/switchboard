/** `switchboard adapters validate` (T4.4): fake adapter and fake CLI only; no provider CLI is ever started. */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type AuthResult, type ProbeResult } from "../adapters/index.js";
import { parseManifest } from "../adapters/manifest/index.js";
import { HELP, main } from "./index.js";
import type { CliIo } from "./io.js";

const MANIFEST = `{
  "schema_version": 1,
  "provider": "fake",
  "validated_cli_version": "0.9.0",
  "validated_version_range": ">=0.9.0 <0.10.0",
  "validated_on": "2026-01-02",
  "auth_modes_allowed": ["native_cached_subscription"],
  "automation_surface": ["documented_headless"],
  "credential_export_allowed": false,
  "dashboard_scraping_allowed": false,
  "network_protocol_reverse_engineering": false,
  "commercial_multi_user_status": "requires-review",
  "source_revision": "not-reviewed: test manifest",
  "notes": "Existing note with \\"quotes\\" and a backslash \\\\."
}
`;
const NO_NOTES = MANIFEST.replace(/,\n {2}"notes".*\n/, "\n");

let tmp: string;
let dir: string;
let file: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-validate-")));
  dir = path.join(tmp, "manifests");
  mkdirSync(dir);
  file = path.join(dir, "fake.json");
  writeFileSync(file, MANIFEST);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function registry(adapter: FakeAdapter = new FakeAdapter()): AdapterRegistry {
  return new AdapterRegistry().register(adapter);
}

async function validate(adapter: FakeAdapter, args: string[] = ["fake"]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    adapters: registry(adapter),
    manifestDir: dir,
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
  const code = await main(["adapters", "validate", ...args, "--json"], io);
  return { code, json: JSON.parse(out.join("")), err: err.join("") };
}

const stepStatus = (j: { steps: { id: string; status: string }[] }) =>
  Object.fromEntries(j.steps.map((s) => [s.id, s.status]));

describe("adapters validate: success (T4.4)", () => {
  it("changes only the four fields, keeps every other line and the manifest still validates", async () => {
    const r = await validate(new FakeAdapter());
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, written: true, provider: "fake", binary_version: "1.0.0", error: null });
    expect(stepStatus(r.json)).toEqual({
      manifest: "ok",
      probe: "ok",
      auth: "ok",
      conformance: "ok",
      smoke: "ok",
      write: "ok",
    });

    const after = readFileSync(file, "utf8");
    const m = parseManifest(after);
    expect(m).toMatchObject({
      validated_cli_version: "1.0.0",
      validated_on: "2026-10-13",
      validated_version_range: ">=1.0.0 <1.1.0",
    });
    expect(
      m.notes?.startsWith('Existing note with "quotes" and a backslash \\. Evidence (adapters validate, 2026-10-13):'),
    ).toBe(true);
    expect(m.notes).toContain("one structured-output smoke call ok");
    // Parsed equality outside the four fields, and a line diff confined to four lines.
    const { validated_cli_version, validated_on, validated_version_range, notes, ...rest } = m;
    const {
      validated_cli_version: a,
      validated_on: b,
      validated_version_range: c,
      notes: d,
      ...restBefore
    } = parseManifest(MANIFEST);
    expect(rest).toEqual(restBefore);
    expect([validated_cli_version, validated_on, validated_version_range, notes]).not.toEqual([a, b, c, d]);
    const was = MANIFEST.split("\n");
    const now = after.split("\n");
    expect(now).toHaveLength(was.length);
    expect(now.flatMap((l, i) => (l === was[i] ? [] : [i]))).toHaveLength(4);
    expect(readdirSync(dir)).toEqual(["fake.json"]); // no temp file left behind
  });

  it("adds a notes property when the manifest has none", async () => {
    writeFileSync(file, NO_NOTES);
    const r = await validate(new FakeAdapter());
    expect(r.code).toBe(0);
    const m = parseManifest(readFileSync(file, "utf8"));
    expect(m.notes?.startsWith("Evidence (adapters validate, 2026-10-13):")).toBe(true);
    expect(m.validated_cli_version).toBe("1.0.0");
  });

  it("prints a human report and says the operator commits the change", async () => {
    const out: string[] = [];
    const io: CliIo = {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: () => {} },
      env: {},
      adapters: registry(),
      manifestDir: dir,
    };
    expect(await main(["adapters", "validate", "fake"], io)).toBe(0);
    const text = out.join("");
    expect(text).toContain("[ok]   smoke");
    expect(text).toContain("commit the manifest file yourself");
    expect(text).toContain("Result: OK");
  });
});

class StepFailAdapter extends FakeAdapter {
  override async probe(runner: Parameters<FakeAdapter["probe"]>[0]): Promise<ProbeResult> {
    const p = await super.probe(runner);
    return { ...p, steps: p.steps.map((s) => (s.step === "flags" ? { ...s, ok: false, detail: "missing --x" } : s)) };
  }
}
class UnknownAuthAdapter extends FakeAdapter {
  override async authPreflight(): Promise<AuthResult> {
    return { state: "UNKNOWN", reason: "no status command" };
  }
}
class ThrowingAuthAdapter extends FakeAdapter {
  override async authPreflight(): Promise<AuthResult> {
    throw new Error("boom");
  }
}
class PrereleaseAdapter extends FakeAdapter {
  override async probe(runner: Parameters<FakeAdapter["probe"]>[0]): Promise<ProbeResult> {
    return { ...(await super.probe(runner)), binaryVersion: "1.0.0-beta.1" };
  }
}

describe("adapters validate: failures write nothing (T4.4)", () => {
  const cases: [string, () => FakeAdapter, string][] = [
    ["binary missing", () => new FakeAdapter({ script: path.join(tmpdir(), "sb-no-such-script.mjs") }), "probe"],
    ["a failed probe step", () => new StepFailAdapter(), "probe"],
    ["a pre-release version", () => new PrereleaseAdapter(), "probe"],
    ["auth AUTH_REQUIRED", () => new FakeAdapter({ scenario: "auth_missing" }), "auth"],
    ["auth UNKNOWN", () => new UnknownAuthAdapter(), "auth"],
    ["auth check throwing", () => new ThrowingAuthAdapter(), "auth"],
    ["a failed smoke step", () => new FakeAdapter({ scenario: "task_failure" }), "smoke"],
    ["malformed smoke output", () => new FakeAdapter({ scenario: "malformed_output" as FakeScenario }), "smoke"],
  ];
  for (const [name, make, failedStep] of cases) {
    it(`${name}: exit 1, file byte-identical, later steps not run`, async () => {
      const before = readFileSync(file);
      const r = await validate(make());
      expect(r.code).toBe(1);
      expect(r.json.ok).toBe(false);
      expect(r.json.written).toBe(false);
      expect(r.json.changes).toBeNull();
      expect(stepStatus(r.json)[failedStep]).toBe("fail");
      expect(r.json.steps.at(-1).id).toBe(failedStep);
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(readdirSync(dir)).toEqual(["fake.json"]);
    });
  }

  it("does not run the smoke call when probe or auth fails", async () => {
    for (const adapter of [new StepFailAdapter(), new UnknownAuthAdapter()]) {
      let compiled = 0;
      const original = adapter.compile.bind(adapter);
      adapter.compile = (...a) => {
        compiled += 1;
        return original(...a);
      };
      expect((await validate(adapter)).code).toBe(1);
      expect(compiled).toBe(0);
    }
  });

  it("names the native login command for AUTH_REQUIRED and never starts a login", async () => {
    const r = await validate(new FakeAdapter({ scenario: "auth_missing" }));
    expect(r.json.error).toContain("AUTH_REQUIRED");
    expect(r.json.error).toContain("fake-cli login");
  });

  it("fails on a missing or invalid manifest and writes nothing", async () => {
    rmSync(file);
    const missing = await validate(new FakeAdapter());
    expect(missing.code).toBe(1);
    expect(stepStatus(missing.json).manifest).toBe("fail");
    writeFileSync(file, MANIFEST.replace('"credential_export_allowed": false', '"credential_export_allowed": true'));
    const bad = readFileSync(file);
    const r = await validate(new FakeAdapter());
    expect(r.code).toBe(1);
    expect(readFileSync(file).equals(bad)).toBe(true);
  });

  it("refuses a manifest whose provider differs", async () => {
    writeFileSync(file, MANIFEST.replace('"provider": "fake"', '"provider": "codex"'));
    const before = readFileSync(file);
    expect((await validate(new FakeAdapter())).code).toBe(1);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe("adapters validate: usage and defaults", () => {
  it("rejects an unknown provider and a missing argument with exit 2", async () => {
    expect((await validate(new FakeAdapter(), ["nope"])).code).toBe(2);
    expect((await validate(new FakeAdapter(), [])).code).toBe(2);
    expect((await validate(new FakeAdapter(), ["fake", "extra"])).code).toBe(2);
  });

  it("rejects an unknown adapters subcommand with exit 2", async () => {
    const io: CliIo = { stdout: { write: () => {} }, stderr: { write: () => {} }, env: {} };
    expect(await main(["adapters", "list"], io)).toBe(2);
    expect(await main(["adapters"], io)).toBe(2);
  });

  it("help says the smoke step makes one provider call and that nothing is written on failure", () => {
    expect(HELP).toContain("adapters validate <provider>");
    expect(HELP).toContain("ONE provider call");
    expect(HELP).toContain("on any failure writes nothing");
  });

  it("the real default resolves the source-tree manifests and has no fake manifest", async () => {
    const { sourceManifestDir } = await import("./adapters-validate.js");
    const real = sourceManifestDir();
    expect(real).toMatch(/src\/adapters\/manifests$/);
    // Copy sanity: the shipped manifests parse with the same loader (read only; nothing is run).
    for (const p of ["claude", "codex"]) {
      const copy = path.join(tmp, `${p}.json`);
      copyFileSync(path.join(real ?? "", `${p}.json`), copy);
      expect(parseManifest(readFileSync(copy, "utf8")).provider).toBe(p);
    }
    const io: CliIo = { stdout: { write: () => {} }, stderr: { write: () => {} }, env: {}, adapters: registry() };
    // No manifestDir injected: the fake has no manifest file in the source tree, so it fails and writes nothing.
    expect(await main(["adapters", "validate", "fake"], io)).toBe(1);
  });
});
