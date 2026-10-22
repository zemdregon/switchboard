/** `switchboard adapters validate` (T4.4): fake adapter and fake CLI only; no provider CLI is ever started. */
import {
  copyFileSync,
  existsSync,
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
import { replayAdapter as antigravityReplay } from "../adapters/antigravity/fixtures/cases.js";
import { findBypassFlags } from "../adapters/audit.js";
import { replayAdapter as cursorReplay } from "../adapters/cursor/fixtures/cases.js";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { privilegedProfile } from "../adapters/fixtures/privileged.js";
import { replayAdapter as grokReplay } from "../adapters/grok/fixtures/cases.js";
import {
  AdapterRegistry,
  type AuthResult,
  type CompileRequest,
  type ExitInfo,
  type FailureCode,
  type Ineligible,
  type Invocation,
  isIneligible,
  type NormalizedEvent,
  type ProbeResult,
  type ProviderAdapter,
  type ResolvedProfile,
  type RunResult,
} from "../adapters/index.js";
import { replayAdapter as kimiReplay } from "../adapters/kimi/fixtures/cases.js";
import { parseManifest } from "../adapters/manifest/index.js";
import { MuseAdapter } from "../adapters/muse/adapter.js";
import { replayAdapter as opencodeReplay } from "../adapters/opencode/fixtures/cases.js";
import { COMPILED_CELL_FALLBACK } from "./adapters-validate.js";
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

function registry(adapter: ProviderAdapter = new FakeAdapter()): AdapterRegistry {
  return new AdapterRegistry().register(adapter);
}

async function validate(adapter: ProviderAdapter, args: string[] = ["fake"]) {
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

  it("validates a CalVer version with a commit hash (T4.48)", async () => {
    const { buildUpdatedManifest } = await import("./adapters-validate.js");
    const { text, changes } = buildUpdatedManifest(
      MANIFEST,
      "fake",
      "2026.10.12-d47ca18",
      "2026-10-14",
      "cursor live check ok",
    );
    expect(changes).toEqual({
      validated_cli_version: "2026.10.12",
      validated_on: "2026-10-14",
      validated_version_range: ">=2026.10.12 <2026.11.0",
      notes_appended: "Evidence (adapters validate, 2026-10-14): cursor live check ok",
    });
    const m = parseManifest(text);
    expect(m.validated_cli_version).toBe("2026.10.12");
    expect(m.validated_version_range).toBe(">=2026.10.12 <2026.11.0");
  });

  it("validates a CalVer version with a commit hash end-to-end (T4.48)", async () => {
    const r = await validate(new CalverCommitAdapter());
    expect(r.code).toBe(0);
    const m = parseManifest(readFileSync(file, "utf8"));
    expect(m.validated_cli_version).toBe("2026.10.12");
    expect(m.validated_version_range).toBe(">=2026.10.12 <2026.11.0");
  });
});

class CalverCommitAdapter extends FakeAdapter {
  override async probe(runner: Parameters<FakeAdapter["probe"]>[0]): Promise<ProbeResult> {
    return { ...(await super.probe(runner)), binaryVersion: "2026.10.12-d47ca18" };
  }
}

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

// ---- Compiled-cell fallback (owner decisions 59 and 60; fakes and replays only) ----

const CELL_NOTE_59 = "approved privileged bypass cell, owner decision 59; inspect-untrusted is Ineligible";
const CELL_NOTE_60 = "approved privileged bypass cell, owner decision 60; inspect-untrusted is Ineligible";

/** A synthetic OK probe and auth for a real adapter whose binary is the shared replay helper; nothing else changes. */
function synthetic<A extends ProviderAdapter>(a: A): A {
  a.probe = async () => ({
    binaryPath: process.execPath,
    binaryVersion: "1.0.0",
    steps: (["binary", "version", "command", "output_format", "flags"] as const).map((step) => ({ step, ok: true })),
  });
  a.authPreflight = async () => ({ state: "OK" });
  return a;
}

/** Records every compile: the profile it ran under, the workspace and the invocation. */
function recordCompiles(a: ProviderAdapter) {
  const calls: { profile: ResolvedProfile; request: CompileRequest; inv: Invocation | Ineligible }[] = [];
  const original = a.compile.bind(a);
  a.compile = (request, profile) => {
    const inv = original(request, profile);
    calls.push({ profile, request, inv });
    return inv;
  };
  return calls;
}

function useManifest(provider: string): string {
  const f = path.join(dir, `${provider}.json`);
  writeFileSync(f, MANIFEST.replace('"provider": "fake"', `"provider": "${provider}"`));
  rmSync(file);
  return f;
}

interface FallbackEntry {
  readonly provider: string;
  readonly make: () => ProviderAdapter;
  /** The cell's declared bypass flag, or null when the cell declares none (no cell since OpenCode's `--auto`, ADR-0077). */
  readonly flag: string | null;
  readonly failFixture: string;
  readonly note: string;
  /** A bypass-class flag planted in the argv to prove the audit refuses it. */
  readonly planted: string;
}

const FALLBACK: FallbackEntry[] = [
  {
    provider: "grok",
    make: () => grokReplay("success_edit"),
    flag: "--always-approve",
    failFixture: "task_failure",
    note: CELL_NOTE_59,
    planted: "--yolo",
  },
  {
    provider: "cursor",
    make: () => cursorReplay("success_edit"),
    flag: "--force",
    failFixture: "task_failure",
    note: CELL_NOTE_59,
    planted: "--yolo",
  },
  {
    provider: "kimi",
    make: () => kimiReplay("success_edit"),
    flag: "--prompt",
    failFixture: "task_failure",
    note: CELL_NOTE_59,
    planted: "--yolo",
  },
  {
    provider: "opencode",
    make: () => opencodeReplay("success_edit"),
    flag: "--auto",
    failFixture: "task_failure",
    note: CELL_NOTE_60,
    planted: "--yolo",
  },
  {
    provider: "antigravity",
    make: () => antigravityReplay("success_edit"),
    flag: "--dangerously-skip-permissions",
    failFixture: "task_failure",
    note: CELL_NOTE_60,
    planted: "--yolo",
  },
];

describe("adapters validate: compiled-cell fallback (owner decisions 59 and 60)", () => {
  it("the allowlist is exactly grok, cursor, kimi, opencode and antigravity", () => {
    expect(Object.keys(COMPILED_CELL_FALLBACK).sort()).toEqual(["antigravity", "cursor", "grok", "kimi", "opencode"]);
  });

  it("every cell declares exactly one bypass flag, OpenCode's being --auto (ADR-0077, 2026-10-21)", () => {
    for (const entry of FALLBACK) {
      const cell = COMPILED_CELL_FALLBACK[entry.provider as keyof typeof COMPILED_CELL_FALLBACK];
      expect(cell?.bypassFlag).toBe(entry.flag);
    }
    expect(COMPILED_CELL_FALLBACK.opencode?.bypassFlag).toBe("--auto");
  });

  for (const entry of FALLBACK) {
    const { provider, make, flag, failFixture, note, planted } = entry;
    const ruling = note.includes("decision 60") ? "owner decision 60" : "owner decision 59";
    it(`${provider}: inspect-untrusted first, then the approved privileged cell; passes and names the cell`, async () => {
      const f = useManifest(provider);
      const adapter = synthetic(make());
      const calls = recordCompiles(adapter);
      const r = await validate(adapter, [provider]);
      expect(r.json.error).toBeNull();
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ ok: true, written: true, provider });
      // Order unchanged: the first compile is inspect-untrusted and Ineligible.
      expect(calls[0]?.profile.name).toBe("inspect-untrusted");
      expect("ineligible" in (calls[0]?.inv ?? {})).toBe(true);
      const smoke = r.json.steps.find((s: { id: string }) => s.id === "smoke");
      expect(smoke).toMatchObject({ status: "ok", smoke_profile: "privileged" });
      expect(smoke.detail).toContain(note);
      expect(r.json.steps.find((s: { id: string }) => s.id === "conformance").detail).toContain(note);
      expect(parseManifest(readFileSync(f, "utf8")).notes).toContain(`one structured-output smoke call ok (${note})`);
      // The smoke argv carries exactly the cell's declared bypass flag and nothing else bypass-class
      // (OpenCode's is `--auto`, ADR-0077).
      const spawned = calls.filter((c) => c.profile.name === "privileged" && c.request.bypassApproved === true);
      const inv = spawned.at(-1)?.inv as Invocation;
      expect(findBypassFlags(inv, provider)).toEqual(flag === null ? [] : [flag]);
      // The approval is in memory only: the profile carries the placeholder id, and the repository is gone.
      expect(spawned.at(-1)?.profile.privilegedScope?.approvalId).toBe("apv_00000000000000000000VA1DAT");
      expect(existsSync(inv.cwd)).toBe(false);
    });

    it(`${provider}: a failing fallback smoke exits 1, writes nothing and removes the repository`, async () => {
      const f = useManifest(provider);
      const before = readFileSync(f);
      const adapter = synthetic(
        provider === "grok"
          ? grokReplay(failFixture)
          : provider === "cursor"
            ? cursorReplay(failFixture)
            : provider === "kimi"
              ? kimiReplay(failFixture)
              : provider === "opencode"
                ? opencodeReplay(failFixture)
                : antigravityReplay(failFixture),
      );
      const calls = recordCompiles(adapter);
      const r = await validate(adapter, [provider]);
      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ ok: false, written: false, changes: null });
      expect(r.json.steps.at(-1)).toMatchObject({ id: "smoke", status: "fail", smoke_profile: "privileged" });
      expect(readFileSync(f).equals(before)).toBe(true);
      expect(readdirSync(dir)).toEqual([`${provider}.json`]);
      expect(existsSync(calls[0]?.request.workspace.cwd ?? "")).toBe(false);
    });

    it(`${provider}: an extra bypass-class flag in the cell's argv fails before any spawn and writes nothing`, async () => {
      const f = useManifest(provider);
      const before = readFileSync(f);
      const adapter = synthetic(make());
      const original = adapter.compile.bind(adapter);
      adapter.compile = (request, profile) => {
        const inv = original(request, profile);
        return "ineligible" in inv ? inv : { ...inv, argv: [...inv.argv, planted] };
      };
      let spawned = 0;
      const parse = adapter.parseEvent.bind(adapter);
      adapter.parseEvent = (...a: Parameters<ProviderAdapter["parseEvent"]>) => {
        spawned += 1;
        return parse(...a);
      };
      const r = await validate(adapter, [provider]);
      expect(r.code).toBe(1);
      if (flag === null) {
        expect(r.json.error).toContain(`none allowed (${ruling})`);
      } else {
        expect(r.json.error).toContain(`only ${flag} is allowed (${ruling})`);
      }
      expect(r.json.error).toContain(planted);
      expect(spawned).toBe(0);
      expect(readFileSync(f).equals(before)).toBe(true);
    });
  }

  it("an adapter outside the allowlist never falls back, even when a privileged cell would compile", async () => {
    const adapter = new FakeAdapter();
    const original = adapter.compile.bind(adapter);
    const profiles: string[] = [];
    adapter.compile = (request, profile) => {
      profiles.push(profile.name);
      if (profile.name === "inspect-untrusted") {
        return { ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: "test: no inspect-untrusted cell" };
      }
      return original(request, profile);
    };
    const before = readFileSync(file);
    const r = await validate(adapter);
    expect(r.code).toBe(1);
    expect(r.json.error).toBe("conformance: static checks failed: compiles");
    // The statics' own "never silently downgraded" probe compiles privileged without approval; nothing approved runs.
    expect(profiles[0]).toBe("inspect-untrusted");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("muse is not on the allowlist: it never falls back, even though its privileged cell would compile", async () => {
    const adapter = synthetic(new MuseAdapter({ executable: process.execPath }));
    // Premise: an approved privileged bypass cell compiles for muse, so validate *could* fall back but must not.
    const profile = privilegedProfile({
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    });
    expect(
      isIneligible(
        adapter.compile(
          {
            runId: "run_premise",
            objective: "synthetic premise objective",
            constraints: [],
            workspace: { cwd: tmp, writable: true },
            bypassApproved: true,
          },
          profile,
        ),
      ),
    ).toBe(false);
    const f = useManifest("muse");
    const before = readFileSync(f);
    const original = adapter.compile.bind(adapter);
    const profiles: string[] = [];
    const approvedRuns: boolean[] = [];
    adapter.compile = (request, p) => {
      profiles.push(p.name);
      approvedRuns.push(request.bypassApproved === true);
      if (p.name === "inspect-untrusted") {
        return { ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: "test: no inspect-untrusted cell" };
      }
      return original(request, p);
    };
    const r = await validate(adapter, ["muse"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toBe("conformance: static checks failed: compiles");
    // The statics' own "never silently downgraded" probe compiles privileged without approval; nothing approved runs.
    expect(profiles[0]).toBe("inspect-untrusted");
    expect(approvedRuns.some((a) => a)).toBe(false);
    expect(readFileSync(f).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(["muse.json"]);
    writeFileSync(file, MANIFEST);
  });

  it("a fake that compiles inspect-untrusted keeps the inspect-untrusted smoke and the old evidence text", async () => {
    const adapter = new FakeAdapter();
    const calls = recordCompiles(adapter);
    const r = await validate(adapter);
    expect(r.code).toBe(0);
    const smoke = r.json.steps.find((s: { id: string }) => s.id === "smoke");
    expect(smoke).toEqual({
      id: "smoke",
      status: "ok",
      detail: "one provider call; a successful structured result was parsed",
      smoke_profile: "inspect-untrusted",
    });
    expect(calls.every((c) => c.request.bypassApproved !== true)).toBe(true);
    expect(parseManifest(readFileSync(file, "utf8")).notes).toContain("(inspect-untrusted, no bypass flag)");
    expect(existsSync(calls[0]?.request.workspace.cwd ?? "")).toBe(false);
  });
});

describe("adapters validate: smoke failure carries the classified detail (T4.4 failure-detail follow-up)", () => {
  /** A smoke run whose classifier reports a fixed code and detail, whatever the fake CLI emitted. */
  class ClassifiedFailAdapter extends FakeAdapter {
    constructor(
      private readonly code: FailureCode,
      private readonly detail: string,
    ) {
      super({ scenario: "task_failure" });
    }
    override extractResult(_events: readonly NormalizedEvent[], _exit: ExitInfo): RunResult {
      return { ok: false, failureCode: this.code, failureDetail: this.detail, unknownEventCount: 0 };
    }
  }

  const smokeOf = (j: { steps: { id: string }[] }) => j.steps.find((s) => s.id === "smoke") as Record<string, unknown>;

  async function validateText(adapter: ProviderAdapter) {
    const out: string[] = [];
    const io: CliIo = {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: () => {} },
      env: {},
      adapters: registry(adapter),
      manifestDir: dir,
      now: () => new Date("2026-10-13T12:00:00Z"),
    };
    const code = await main(["adapters", "validate", "fake"], io);
    return { code, text: out.join("") };
  }

  it("a fake smoke failure with a known classification prints the code and detail in text and JSON", async () => {
    const r = await validate(new ClassifiedFailAdapter("QUOTA_EXHAUSTED", "out of usage"));
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.written).toBe(false);
    const smoke = smokeOf(r.json);
    expect(smoke).toMatchObject({ status: "fail", failure_code: "QUOTA_EXHAUSTED", failure_detail: "out of usage" });
    expect(smoke.detail).toBe("structured-output smoke test failed: QUOTA_EXHAUSTED (exit code 1): out of usage");
    expect(r.json.error).toContain("QUOTA_EXHAUSTED (exit code 1): out of usage");

    const t = await validateText(new ClassifiedFailAdapter("QUOTA_EXHAUSTED", "out of usage"));
    expect(t.code).toBe(1);
    expect(t.text).toContain(
      "[FAIL] smoke: structured-output smoke test failed: QUOTA_EXHAUSTED (exit code 1): out of usage",
    );
    expect(t.text).toContain("Nothing was written.");
    expect(t.text).toContain("Result: FAILED");
  });

  it("a planted secret-like token, an e-mail and a URL query never appear in the output", async () => {
    const planted = "sk-ant-secret-abcdefghijklmnopqrstuvwxyz1234";
    const detail = `quota stop for alice@example.com at https://example.com/usage?token=abc123&user=alice using ${planted}`;
    const r = await validate(new ClassifiedFailAdapter("QUOTA_EXHAUSTED", detail));
    expect(r.code).toBe(1);
    const dumped = JSON.stringify(r.json);
    for (const secret of [planted, "alice@example.com", "token=abc123"]) {
      expect(dumped).not.toContain(secret);
    }
    expect(dumped).toContain("QUOTA_EXHAUSTED");
    expect(dumped).toContain("[REDACTED]");
    expect(String(smokeOf(r.json).failure_detail)).toContain("https://example.com/usage");

    const t = await validateText(new ClassifiedFailAdapter("QUOTA_EXHAUSTED", detail));
    for (const secret of [planted, "alice@example.com", "token=abc123"]) {
      expect(t.text).not.toContain(secret);
    }
  });

  it("a long detail is clipped and stays on one line", async () => {
    const detail = `first line\nsecond line ${"x".repeat(500)}`;
    const r = await validate(new ClassifiedFailAdapter("TOOL_FAILURE", detail));
    expect(r.code).toBe(1);
    const smoke = smokeOf(r.json);
    expect(String(smoke.detail)).not.toContain("\n");
    expect(String(smoke.failure_detail)).not.toContain("\n");
    expect(String(smoke.failure_detail)).toHaveLength(200);
    expect(JSON.stringify(r.json)).not.toContain("x".repeat(500));
  });

  it("the success output is unchanged and carries no failure fields", async () => {
    const r = await validate(new FakeAdapter());
    expect(r.code).toBe(0);
    const smoke = smokeOf(r.json);
    expect(smoke).toEqual({
      id: "smoke",
      status: "ok",
      detail: "one provider call; a successful structured result was parsed",
      smoke_profile: "inspect-untrusted",
    });
    expect("failure_code" in smoke).toBe(false);
    expect("failure_detail" in smoke).toBe(false);
  });
});
