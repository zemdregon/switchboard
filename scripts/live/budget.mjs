/**
 * Live-test budget guard (T8.9, NFR-MAINT-05; TDD §3.6 "Live-test budget guard"). `scripts/live-smoke.mjs` and
 * `scripts/live-pair.mjs` call {@link admitLiveRun} after choosing their provider(s) and before anything spawns a
 * provider CLI (probe, auth status, `switchboard serve`).
 *
 *   SWITCHBOARD_LIVE_BUDGET_FILE  absolute path of the operator's budget file, outside the repository. Unset: today's
 *                                 behaviour plus one warning on stderr. Set: the file must parse, or the run is refused.
 *   SWITCHBOARD_LIVE_PURPOSE      why this run is made; must be on the file's `purposes` list when the file is set.
 *
 * File format (JSON, `schema_version` 1; every key below is required unless marked optional; unknown keys are errors):
 *   {
 *     "schema_version": 1,
 *     "window_hours": 24,                    rolling window for both caps, (0, 720]
 *     "global_max_runs": 4,                  provider runs allowed in the window across all providers, >= 0
 *     "min_gap_seconds": 900,                seconds after the previous `start` before another run may start, >= 0
 *     "purposes": ["pre-check", "final-verify"],
 *     "providers": { "<id>": { "max_runs": 2, "model": "<model id>" } },   a provider not listed is refused
 *     "audit_log": "/abs/path.jsonl"         optional; default `<budget file>.jsonl`; outside the repository
 *   }
 *
 * A provider run is one task on one provider: the smoke test is one, a live pair direction is one per provider. Each
 * admitted invocation appends a `start` record and, when the process exits, a `finish` record with its exit code; a
 * refused one appends a `denied` record (when the audit log is known) and the caller exits {@link EXIT_REFUSED}. Only
 * `start` records count against the caps and the gap. Records carry no prompt, output, account or credential value.
 * Pacing (ADR-0055) is not involved: it never refuses, this guard must.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

/** `EX_TEMPFAIL` from sysexits(3): a refusal the operator can retry later, distinct from 1 (checks failed) and 2. */
export const EXIT_REFUSED = 75;
export const BUDGET_FILE_ENV = "SWITCHBOARD_LIVE_BUDGET_FILE";
export const PURPOSE_ENV = "SWITCHBOARD_LIVE_PURPOSE";
/** The same plain-identifier rule as `MODEL_ID_PATTERN` (src/models/registry.ts): the model goes into argv. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const PURPOSE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PROVIDER_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TOP_KEYS = [
  "schema_version",
  "window_hours",
  "global_max_runs",
  "min_gap_seconds",
  "purposes",
  "providers",
  "audit_log",
];

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Validate a parsed budget file. Returns `{ ok: true, budget }` or `{ ok: false, reason }`. `file` is the budget file's
 * absolute path (for the default audit log) and `repoRoot` the repository root both paths must stay outside.
 */
export function parseBudget(doc, file, repoRoot) {
  const bad = (reason) => ({ ok: false, reason: `budget file: ${reason}` });
  if (!isObj(doc)) return bad("not a JSON object");
  const unknown = Object.keys(doc).filter((k) => !TOP_KEYS.includes(k));
  if (unknown.length > 0) return bad(`unknown key(s) ${unknown.join(", ")}`);
  if (doc.schema_version !== 1) return bad("schema_version must be 1");
  if (typeof doc.window_hours !== "number" || !(doc.window_hours > 0 && doc.window_hours <= 720))
    return bad("window_hours must be a number in (0, 720]");
  if (!isCount(doc.global_max_runs)) return bad("global_max_runs must be an integer >= 0");
  if (!isCount(doc.min_gap_seconds)) return bad("min_gap_seconds must be an integer >= 0");
  if (!Array.isArray(doc.purposes) || doc.purposes.some((p) => typeof p !== "string" || !PURPOSE_RE.test(p)))
    return bad("purposes must be a list of lower-case ids");
  if (!isObj(doc.providers)) return bad("providers must be an object");
  const providers = {};
  for (const [id, p] of Object.entries(doc.providers)) {
    if (!PROVIDER_RE.test(id)) return bad(`provider id ${JSON.stringify(id)} is not a plug-in id`);
    if (!isObj(p) || Object.keys(p).some((k) => k !== "max_runs" && k !== "model"))
      return bad(`providers.${id} takes exactly max_runs and model`);
    if (!isCount(p.max_runs)) return bad(`providers.${id}.max_runs must be an integer >= 0`);
    if (typeof p.model !== "string" || !MODEL_RE.test(p.model))
      return bad(`providers.${id}.model must be a plain model id`);
    providers[id] = { max_runs: p.max_runs, model: p.model };
  }
  if (doc.audit_log !== undefined && (typeof doc.audit_log !== "string" || !path.isAbsolute(doc.audit_log)))
    return bad("audit_log must be an absolute path");
  const auditLog = path.resolve(doc.audit_log ?? `${file}.jsonl`);
  if (inside(repoRoot, auditLog)) return bad("audit_log must be outside the repository");
  return {
    ok: true,
    budget: {
      windowMs: doc.window_hours * 3_600_000,
      globalMax: doc.global_max_runs,
      minGapMs: doc.min_gap_seconds * 1000,
      purposes: [...doc.purposes],
      providers,
      auditLog,
    },
  };
}

/** Parse the audit log (JSONL). A missing file is empty; an unparseable line refuses (fail closed). */
export function readAudit(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, records: [] };
    return { ok: false, reason: `audit log unreadable (${err?.code ?? "error"})` };
  }
  const records = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return { ok: false, reason: `audit log line ${i + 1} is not JSON` };
    }
  }
  return { ok: true, records };
}

/**
 * The decision, pure: may `runs` (provider id -> provider runs) start at `nowMs` for `purpose` given the earlier audit
 * `records`? Returns `{ allow: true, models }` (the file's model per provider) or `{ allow: false, reason }`.
 */
export function decide(budget, records, { runs, purpose, nowMs }) {
  if (typeof purpose !== "string" || !budget.purposes.includes(purpose))
    return { allow: false, reason: `purpose ${JSON.stringify(purpose ?? "")} is not on the budget file's allowlist` };
  for (const id of Object.keys(runs)) {
    if (!budget.providers[id]) return { allow: false, reason: `provider ${id} is not in the budget file` };
  }
  const starts = records.filter((r) => r?.event === "start" && Number.isFinite(Date.parse(r.ts)));
  const last = Math.max(-Infinity, ...starts.map((r) => Date.parse(r.ts)));
  if (nowMs - last < budget.minGapMs) {
    const wait = Math.ceil((budget.minGapMs - (nowMs - last)) / 1000);
    return { allow: false, reason: `inside the minimum gap: ${wait} s until the next run may start` };
  }
  const recent = starts.filter((r) => nowMs - Date.parse(r.ts) < budget.windowMs);
  const used = (id) => recent.reduce((n, r) => n + (Number(r.providers?.[id]?.runs) || 0), 0);
  const usedAll = recent.reduce(
    (n, r) => n + Object.values(r.providers ?? {}).reduce((m, p) => m + (Number(p?.runs) || 0), 0),
    0,
  );
  const want = Object.values(runs).reduce((n, k) => n + k, 0);
  if (usedAll + want > budget.globalMax)
    return {
      allow: false,
      reason: `global cap: ${usedAll} of ${budget.globalMax} provider runs used in the window, ${want} requested`,
    };
  for (const [id, k] of Object.entries(runs)) {
    const cap = budget.providers[id].max_runs;
    if (used(id) + k > cap)
      return {
        allow: false,
        reason: `${id} cap: ${used(id)} of ${cap} provider runs used in the window, ${k} requested`,
      };
  }
  return { allow: true, models: Object.fromEntries(Object.keys(runs).map((id) => [id, budget.providers[id].model])) };
}

/**
 * Admit one invocation of a live script. `runs` maps provider id to the provider runs the invocation will make.
 * Returns `{ configured: false }` (no budget file; a warning was written), `{ configured: true, allowed: true, models }`
 * (a `start` record was appended and a `finish` record is appended on process exit) or
 * `{ configured: true, allowed: false, reason }` (a `denied` record was appended when the audit log is known; the caller
 * exits {@link EXIT_REFUSED} without spawning anything). `now` is injectable for tests.
 */
export function admitLiveRun({ script, runs, repoRoot, env = process.env, now = () => Date.now(), warn, onExit }) {
  const write = warn ?? ((s) => process.stderr.write(`${s}\n`));
  const file = env[BUDGET_FILE_ENV];
  if (file === undefined || file === "") {
    write(`${script}: warning: ${BUDGET_FILE_ENV} is not set; no live-test budget is enforced (NFR-MAINT-05)`);
    return { configured: false };
  }
  const refuse = (reason) => ({ configured: true, allowed: false, reason });
  if (!path.isAbsolute(file)) return refuse(`${BUDGET_FILE_ENV} must be an absolute path`);
  if (inside(repoRoot, path.resolve(file))) return refuse("the budget file must be outside the repository");
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return refuse(`budget file unreadable or not JSON (${err?.code ?? "parse error"})`);
  }
  const parsed = parseBudget(doc, path.resolve(file), repoRoot);
  if (!parsed.ok) return refuse(parsed.reason);
  const { budget } = parsed;
  const purpose = env[PURPOSE_ENV];
  const nowMs = now();
  const base = { script, run: `live_${randomBytes(8).toString("hex")}`, purpose: purpose ?? null };
  const append = (rec) =>
    appendFileSync(budget.auditLog, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...rec })}\n`);
  const audit = readAudit(budget.auditLog);
  const verdict = audit.ok
    ? decide(budget, audit.records, { runs, purpose, nowMs })
    : { allow: false, reason: audit.reason };
  if (!verdict.allow) {
    try {
      append({
        event: "denied",
        ...base,
        providers: Object.fromEntries(Object.entries(runs).map(([id, k]) => [id, { runs: k }])),
        reason: verdict.reason,
      });
    } catch {
      // The refusal stands even when the record cannot be written.
    }
    return refuse(verdict.reason);
  }
  const providers = Object.fromEntries(
    Object.entries(runs).map(([id, k]) => [id, { runs: k, model: verdict.models[id] }]),
  );
  append({ event: "start", ...base, providers });
  (onExit ?? ((fn) => process.on("exit", fn)))((code) =>
    append({ event: "finish", ...base, providers, exit_code: code }),
  );
  return { configured: true, allowed: true, models: verdict.models };
}

/**
 * The file's model reaches the provider through Switchboard's own surface (no new flag): the serve config's
 * `providers.<id>.models` registry holds only that model, declared `low`, and the run asks for
 * `routing.minimum_capability: "low"`, so stage 1 compiles the provider with it (T7.8, `src/routing/collect.ts`).
 * Unconfigured (`model` undefined) returns nothing to add, so the config and routing stay as on `main`.
 */
export function modelHandoff(model) {
  if (model === undefined) return { provider: undefined, routing: {} };
  return {
    provider: { models: { ids: [model], capabilities: { [model]: "low" } } },
    routing: { minimum_capability: "low" },
  };
}

/** The in-script compile request (flag audit) with the file's model, whatever model the caller's request named. */
export function withBudgetModel(request, model) {
  if (model === undefined) return request;
  return { ...request, model };
}
