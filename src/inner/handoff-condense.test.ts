/**
 * Handoff-bundle condensation (T11.10; FR-INN-13, FR-SES-04, LLD §13.6, ADR-0038). The inner backend is the scripted
 * in-process fake: no network, no model, no provider CLI. The handoff view is a stored version 1 bundle. Every test
 * that condenses asserts the view's bytes, and so every structured field, are unchanged.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { resolveInnerAgent } from "../config/inner-agent.js";
import type { HandoffBundle } from "../continuity/bundle-schema.js";
import { AWS_KEY, SHA_A, syntheticBundle } from "../continuity/fixtures/handoff-bundle.js";
import { parseHandoffBundle } from "../continuity/render.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { canonicalJson } from "../lifecycle/request.js";
import { MCP_ARTIFACT_KINDS } from "../mcp/schemas.js";
import {
  buildHandoffCondenseInput,
  type CondensedField,
  condenseHandoffBundle,
  createFakeBackend,
  createInnerAgent,
  extractProseFields,
  type FakeBackend,
  type FakeStep,
  FIELD_MAX_CHARS,
  HANDOFF_CONDENSE_EVENT,
  HANDOFF_CONDENSE_TEMPLATE_VERSION,
  type HandoffCondenseDeps,
  PROMPT_PROVIDER_NAMES,
  PROSE_FIELDS,
  type ProseField,
  truncateHandoffInput,
  truncateProseField,
  validateHandoffCondense,
} from "./index.js";

// A planted secret in the `sk-` shape the artifact redactor knows. Assembled so no scanner flags this file.
const SECRET = `sk-${"planted0123456789ABCDEF"}`;

let root: string;
let db: ReturnType<typeof openLedger>;
let ledger: Ledger;
let store: ArtifactStore;
let sessionId: string;
let runId: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-handoff-condense-")));
  db = openLedger(path.join(root, "d"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new ArtifactStore(path.join(root, "d", "artifacts"));
  const session = ledger.createMetaSession({ objective: "test" });
  sessionId = session.id;
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  runId = run.id;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function storeBundle(bundle: HandoffBundle): Promise<{ id: string; sha256: string; bytes: Buffer }> {
  const redacted = store.redactContent(Buffer.from(canonicalJson(bundle), "utf8"));
  const stored = await store.put(redacted);
  const id = ledger.insertArtifact({
    runId,
    metaSessionId: sessionId,
    kind: "handoff_view",
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    mediaType: "application/json",
  });
  return { id, sha256: stored.sha256, bytes: await store.get(stored.sha256) };
}

const viewBytes = async () => {
  const art = ledger
    .listArtifactsForRun(runId)
    .filter((a) => a.kind === "handoff_view")
    .at(-1);
  if (art === undefined) throw new Error("no handoff view");
  return store.get(art.sha256);
};

interface Opts {
  enabled?: boolean;
  task?: boolean;
  locality?: "local" | "remote";
  allowRemote?: boolean;
  allowSourceContent?: boolean;
  script?: readonly FakeStep[];
}

function deps(o: Opts = {}): { deps: HandoffCondenseDeps; backend: FakeBackend } {
  const providerNames = ["claude-code", "codex", "fake", ...PROMPT_PROVIDER_NAMES];
  const settings = resolveInnerAgent({
    enabled: o.enabled ?? true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:9",
      model: "local-model",
      allow_remote: o.allowRemote ?? false,
    },
    tasks: {
      handoff_condense: {
        enabled: o.task ?? true,
        ...(o.allowSourceContent !== undefined ? { allow_source_content: o.allowSourceContent } : {}),
      },
    },
  });
  const backend = createFakeBackend({ locality: o.locality ?? "local", ...(o.script ? { script: o.script } : {}) });
  const service = createInnerAgent(settings, { backend, ledger, providerNames });
  return { deps: { service, ledger, artifacts: store }, backend };
}

const text = (value: unknown): FakeStep => ({ kind: "text", text: JSON.stringify(value) });
const condenseArtifacts = () => ledger.listArtifactsForRun(runId).filter((a) => a.kind === "handoff_condense");
const callRows = () => ledger.listInnerCalls({ runId });
const runSnapshot = () => JSON.stringify(ledger.getRunRecord(runId));

/** A short accepted value for every prose field that is actually present. No digits. */
function acceptedFields(prose: Partial<Record<ProseField, string>>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of PROSE_FIELDS)
    if (prose[name] !== undefined) fields[name] = name === "goal" ? "Add a parser." : "kept short";
  return fields;
}

function bundleForTest(): HandoffBundle {
  const base = syntheticBundle();
  const diagnostics = base.diagnostics;
  if (diagnostics === null) throw new Error("fixture diagnostics");
  return syntheticBundle({
    diagnostics: {
      ...diagnostics,
      commands: diagnostics.commands.map((c, i) =>
        i === 0 ? { ...c, output_excerpt: { stdout: "DIAGNOSTIC_ONLY_MARKER", stderr: "1 failing" } } : c,
      ),
    },
  });
}

describe("handoff_condense task: structured fields stay identical", () => {
  it("labels an accepted condensation and leaves the handoff view byte-identical", async () => {
    const stored = await storeBundle(bundleForTest());
    const before = await viewBytes();
    expect(before.equals(stored.bytes)).toBe(true);
    const parsed = parseHandoffBundle(before);
    const prose = extractProseFields(parsed);
    const runBefore = runSnapshot();

    const off = deps({ task: false });
    expect(await condenseHandoffBundle(off.deps, { runId })).toEqual({ ok: false, reason: "NOT_ENABLED" });
    expect(off.backend.requests).toHaveLength(0);
    expect((await viewBytes()).equals(before)).toBe(true);

    const on = deps({ script: [text({ fields: acceptedFields(prose) })] });
    const r = await condenseHandoffBundle(on.deps, { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("inner");
    expect(r.rawArtifactId).toBe(stored.id);
    expect(r.rawSha256).toBe(stored.sha256);
    expect((await viewBytes()).equals(before)).toBe(true);
    expect(parseHandoffBundle(await viewBytes())).toEqual(parsed);
    expect(r.bundle).toEqual(parsed);
    expect(runSnapshot()).toBe(runBefore);

    // statuses, exit codes, counts and identifiers are not in the prompt; the prose is
    const prompt = on.backend.requests.map((q) => q.user).join("\n");
    expect(prompt).toContain("goal:\nAdd a parser for the config file");
    expect(prompt).toContain("diff_excerpts:");
    expect(prompt).toContain("src/lexer.ts");
    expect(prompt).not.toContain("DIAGNOSTIC_ONLY_MARKER");
    expect(prompt).not.toContain(parsed.runs[0]?.failure_code ?? "TEST_FAILURE");
    expect(prompt).not.toContain(parsed.runs[0]?.run_id ?? "");
    expect(prompt).not.toContain(parsed.as_of.meta_session_id);
    expect(prompt).not.toContain(SHA_A);
    expect(prompt).not.toContain("1200");
    expect(prompt).not.toContain("edit-untrusted");
    expect(prompt).not.toContain(AWS_KEY);
    expect(prompt).not.toMatch(/\bFAILED\b/u);

    for (const [name, field] of Object.entries(r.fields) as [string, CondensedField][]) {
      expect(field.source).toBe("inner");
      expect(field.model_id).toBe("fake-model");
      expect(field.template_version).toBe(HANDOFF_CONDENSE_TEMPLATE_VERSION);
      expect(field.raw_artifact_id).toBe(stored.id);
      expect(field.raw_sha256).toBe(stored.sha256);
      expect(field.text.length).toBeGreaterThan(0);
      expect(name).toBeTruthy();
    }
    const [art] = condenseArtifacts();
    expect(art).toMatchObject({
      id: r.condensationArtifactId,
      kind: "handoff_condense",
      media_type: "application/json",
      run_id: runId,
    });
    const body = JSON.parse((await store.get(art?.sha256 ?? "")).toString("utf8")) as {
      fields: Record<string, CondensedField>;
    };
    expect(body.fields.goal).toMatchObject({
      text: "Add a parser.",
      source: "inner",
      model_id: "fake-model",
      template_version: HANDOFF_CONDENSE_TEMPLATE_VERSION,
      raw_artifact_id: stored.id,
      raw_sha256: stored.sha256,
    });
    const ev = ledger.listRunEvents(runId).filter((e) => e.type === HANDOFF_CONDENSE_EVENT);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.artifact_id).toBe(r.condensationArtifactId);
    const payload = JSON.parse(ev[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({ source: "inner", raw_artifact_id: stored.id, raw_sha256: stored.sha256 });
    expect(ev[0]?.payload_json ?? "").not.toContain("Add a parser.");
    expect(callRows().map((c) => [c.task, c.outcome])).toEqual([["handoff_condense", "accepted"]]);
    expect(ledger.listRunEvents(runId).find((e) => e.type === "inner_call")?.artifact_id).toBe(
      r.condensationArtifactId,
    );
    expect(MCP_ARTIFACT_KINDS).toContain("handoff_condense");
  });

  it("a value longer than its field, an invented number, or a foreign key is rejected and the view is unchanged", async () => {
    const stored = await storeBundle(bundleForTest());
    const before = await viewBytes();
    const prose = extractProseFields(parseHandoffBundle(before));
    const cases: Record<string, string>[] = [
      { ...acceptedFields(prose), goal: "x".repeat(500) },
      { ...acceptedFields(prose), goal: "found 9999 issues" },
      { ...acceptedFields(prose), status: "SUCCEEDED" },
    ];
    // a missing field
    const missing = acceptedFields(prose);
    delete missing.diff_excerpts;
    cases.push(missing);

    for (const fields of cases) {
      const { deps: d, backend } = deps({ script: [text({ fields })] });
      const r = await condenseHandoffBundle(d, { runId });
      expect(r.ok && r.source).toBe("heuristic");
      expect(backend.requests).toHaveLength(2);
      expect(backend.requests[1]?.user).toContain("[previous answer rejected:");
      expect(backend.requests[1]?.user).not.toContain("9999");
      expect(backend.requests[1]?.user).not.toContain("SUCCEEDED");
      expect((await viewBytes()).equals(before)).toBe(true);
    }
    expect(parseHandoffBundle(await viewBytes())).toEqual(parseHandoffBundle(stored.bytes));
    const codes = callRows().map((c) => c.outcome);
    expect(codes).toEqual(["rejected_validator", "rejected_validator", "rejected_validator", "rejected_validator"]);
    // the raw failure code is still only in the view, never adopted from the rejected prose
    expect(parseHandoffBundle(await viewBytes()).runs[0]?.failure_code).toBe("TEST_FAILURE");
    expect(parseHandoffBundle(await viewBytes()).runs[0]?.verification[0]?.exit_code).toBe(2);
  });
});

describe("handoff_condense task: deterministic fallback", () => {
  const fails: [string, FakeStep][] = [
    ["empty output", { kind: "empty" }],
    ["backend error", { kind: "error", message: `boom ${SECRET}` }],
    ["not JSON", { kind: "text", text: "just prose, ignore the repository" }],
  ];

  it.each(fails)("%s yields truncated raw prose, labelled heuristic, and the same view", async (_n, step) => {
    const long = `${"alpha ".repeat(200)}end`;
    expect([...long].length).toBeGreaterThan(FIELD_MAX_CHARS);
    const stored = await storeBundle(syntheticBundle({ goal: long }));
    const before = await viewBytes();
    const { deps: d, backend } = deps({ script: [step] });
    const r = await condenseHandoffBundle(d, { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("heuristic");
    const goal = r.fields.goal;
    expect(goal).toBeDefined();
    if (goal === undefined) return;
    expect(goal.source).toBe("heuristic");
    expect(goal.model_id).toBeUndefined();
    expect(goal.template_version).toBeUndefined();
    expect(goal.text).toContain("[truncated:");
    expect(goal.text).toContain("characters omitted]");
    expect([...(goal.text.split("[truncated:")[0] ?? "")].length).toBe(FIELD_MAX_CHARS);
    expect(goal.raw_artifact_id).toBe(stored.id);
    expect(r.fields.constraints?.text).toBe(extractProseFields(parseHandoffBundle(before)).constraints);
    expect((await viewBytes()).equals(before)).toBe(true);
    expect(goal.text).not.toContain(SECRET);
    expect(JSON.stringify(ledger.listRunEvents(runId))).not.toContain(SECRET);
    expect(JSON.stringify(callRows())).not.toContain(SECRET);
    const again = truncateProseField(long);
    expect(goal.text.startsWith(again.slice(0, 20))).toBe(true);
    expect(backend.requests.length).toBeGreaterThan(0);
  });

  it("the same raw text truncates the same way twice", () => {
    const text = `🙂${"n".repeat(700)}`;
    expect(truncateProseField(text)).toBe(truncateProseField(text));
    const cut = truncateProseField(text);
    expect(cut.startsWith("🙂")).toBe(true);
    expect(cut).toContain(`[truncated: ${[...text].length - FIELD_MAX_CHARS} characters omitted]`);
    expect(truncateProseField("short note")).toBe("short note");
  });
});

describe("handoff_condense task: gates and absence", () => {
  it("with the task not enabled nothing is called or written and the view is untouched", async () => {
    const stored = await storeBundle(bundleForTest());
    for (const o of [{ task: false }, { enabled: false }]) {
      const { deps: d, backend } = deps(o);
      expect(await condenseHandoffBundle(d, { runId })).toEqual({ ok: false, reason: "NOT_ENABLED" });
      expect(backend.requests).toHaveLength(0);
    }
    expect(condenseArtifacts()).toEqual([]);
    expect(callRows()).toEqual([]);
    expect(ledger.listRunEvents(runId).some((e) => e.type === HANDOFF_CONDENSE_EVENT)).toBe(false);
    expect((await viewBytes()).equals(stored.bytes)).toBe(true);
  });

  it("a run with no handoff view has nothing to condense", async () => {
    const { deps: d, backend } = deps();
    expect(await condenseHandoffBundle(d, { runId })).toEqual({ ok: false, reason: "NO_HANDOFF" });
    expect(backend.requests).toHaveLength(0);
  });

  it("a malformed view is refused and a view with no prose is not sent", async () => {
    const bad = await store.put(Buffer.from("{not json", "utf8"));
    ledger.insertArtifact({
      runId,
      metaSessionId: sessionId,
      kind: "handoff_view",
      sha256: bad.sha256,
      sizeBytes: bad.sizeBytes,
      mediaType: "application/json",
    });
    const malformed = deps();
    expect(await condenseHandoffBundle(malformed.deps, { runId })).toEqual({ ok: false, reason: "MALFORMED" });
    expect(malformed.backend.requests).toHaveLength(0);

    const empty = syntheticBundle({
      goal: "",
      constraints: [],
      instructions: [],
      decisions: [],
      reported: [],
      open_work: [],
      diff_excerpts: [],
    });
    await storeBundle(empty);
    // the malformed view is older; the entry point reads the latest
    const quiet = deps();
    expect(await condenseHandoffBundle(quiet.deps, { runId })).toEqual({ ok: false, reason: "NO_PROSE" });
    expect(quiet.backend.requests).toHaveLength(0);
  });

  it.each([
    [
      "a remote backend without allow_remote",
      { locality: "remote" as const, allowRemote: false },
      "REMOTE_NOT_ALLOWED",
    ],
    [
      "a remote backend without the per-task source opt-in",
      { locality: "remote" as const, allowRemote: true },
      "SOURCE_CONTENT_NOT_ALLOWED",
    ],
  ])("%s: no byte is sent, the fallback is stored, and the view is unchanged", async (_n, o, reason) => {
    const stored = await storeBundle(bundleForTest());
    const before = await viewBytes();
    const prose = extractProseFields(parseHandoffBundle(before));
    const { deps: d, backend } = deps({ ...o, script: [text({ fields: acceptedFields(prose) })] });
    const r = await condenseHandoffBundle(d, { runId });
    expect(r.ok && r.source).toBe("heuristic");
    expect(backend.requests).toHaveLength(0);
    expect(callRows().map((c) => [c.outcome, c.reason])).toEqual([["fallback_disabled", reason]]);
    expect((await viewBytes()).equals(stored.bytes)).toBe(true);
  });

  it("a remote backend with both opt-ins is called; a project set to off or local_only is not", async () => {
    await storeBundle(bundleForTest());
    const prose = extractProseFields(parseHandoffBundle(await viewBytes()));
    const ok = deps({
      locality: "remote",
      allowRemote: true,
      allowSourceContent: true,
      script: [text({ fields: acceptedFields(prose) })],
    });
    const accepted = await condenseHandoffBundle(ok.deps, { runId });
    expect(accepted.ok && accepted.source).toBe("inner");
    expect(ok.backend.requests).toHaveLength(1);
    for (const [setting, locality] of [
      ["off", "local"],
      ["local_only", "remote"],
    ] as const) {
      const blocked = deps({
        locality,
        allowRemote: true,
        allowSourceContent: true,
        script: [text({ fields: acceptedFields(prose) })],
      });
      const r = await condenseHandoffBundle(blocked.deps, { runId, projectSetting: setting });
      expect(r.ok && r.source).toBe("heuristic");
      expect(blocked.backend.requests).toHaveLength(0);
    }
  });

  it("a planted secret, home path and native session id never reach the prompt", async () => {
    const native = "native-session-0001";
    const home = homedir();
    await storeBundle(
      syntheticBundle({
        goal: `notes at ${home}/note mentioning claude and ${SECRET} and ${native}`,
      }),
    );
    const prose = extractProseFields(parseHandoffBundle(await viewBytes()));
    const { deps: d, backend } = deps({ script: [text({ fields: acceptedFields(prose) })] });
    // `deps` gives the service the provider list the pipeline scrubs, including `claude`.
    const r = await condenseHandoffBundle(d, { runId, nativeSessionIds: [native] });
    expect(r.ok && r.source).toBe("inner");
    const prompt = backend.requests.map((q) => `${q.system}\n${q.user}`).join("\n");
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain(native);
    expect(prompt).not.toContain(home);
    expect(prompt).not.toContain(AWS_KEY);
    expect(prompt).not.toMatch(/\bclaude\b/iu);
    const stored = JSON.stringify([ledger.listRunEvents(runId), callRows(), r]);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(AWS_KEY);
  });
});

describe("handoff_condense pieces", () => {
  it("the digit rule is per whole run of the text the model was given, and a value cannot outgrow its field", () => {
    const seen = "goal:\nfix item 17\n\ndecisions:\n- route_selected: mode new";
    const requested = ["goal", "decisions"];
    const lengths = new Map([
      ["goal", 40],
      ["decisions", 40],
    ]);
    const ok = { fields: { goal: "fix item 17", decisions: "mode new" } };
    expect(validateHandoffCondense(ok, requested, lengths, seen)).toBeNull();
    expect(
      validateHandoffCondense({ fields: { goal: "1700 items", decisions: "mode new" } }, requested, lengths, seen),
    ).toBe("invented_number");
    expect(
      validateHandoffCondense({ fields: { goal: "x".repeat(41), decisions: "mode new" } }, requested, lengths, seen),
    ).toBe("longer_than_source");
    expect(
      validateHandoffCondense({ fields: { goal: "two\nlines", decisions: "mode new" } }, requested, lengths, seen),
    ).toBe("control");
    expect(validateHandoffCondense({ fields: { goal: "fix item 17" } }, requested, lengths, seen)).toBe("fields");
  });

  it("extraction omits structured statuses and the budget keeps the sections ahead of the diff", () => {
    const bundle = bundleForTest();
    const prose = extractProseFields(bundle);
    expect(prose.goal).toBe("Add a parser for the config file");
    expect(prose.failed_attempt_notes).toContain("failure_detail:");
    expect(prose.failed_attempt_notes).not.toContain("TEST_FAILURE");
    expect(prose.open_tasks).toContain("npm test");
    expect(prose.open_tasks).not.toContain("TEST_FAILURE");
    expect(prose.open_tasks).not.toContain("run_01AAA");
    const input = buildHandoffCondenseInput(prose);
    expect(input).not.toContain("DIAGNOSTIC_ONLY_MARKER");
    expect(input).not.toContain(SHA_A);
    const big = buildHandoffCondenseInput({
      ...prose,
      diff_excerpts: `== f ==\nHEAD\n${"mid\n".repeat(4000)}TAIL`,
    });
    const cut = truncateHandoffInput(big, 1500);
    expect(cut.omitted).toBeGreaterThan(0);
    expect(cut.text).toContain("goal:\nAdd a parser for the config file");
    expect(cut.text).toContain("HEAD");
    expect(cut.text).toContain("TAIL");
    expect(cut.text).toContain("[truncated:");
    // Head and tail of the excerpt stay; the repeated middle is what the marker accounts for.
    const keptMids = cut.text.split("mid\n").length - 1;
    expect(keptMids).toBeGreaterThan(0);
    expect(keptMids).toBeLessThan(400);
  });
});
