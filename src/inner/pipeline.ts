/**
 * Inner-agent call pipeline (T11.2; FR-INN-07, FR-INN-08, FR-INN-16, LLD §13.4, §13.7, §13.8, ADR-0016).
 *
 * One pipeline serves every task; a task contract supplies the template, schema, validator, sanitiser and fallback. The
 * pipeline NEVER throws into its caller and never changes a run's state: every failure becomes the task's deterministic
 * fallback within the per-call bound (FR-INN-08). Nothing here reads a prompt or a completion into a log, a ledger row or
 * an event: rows hold sizes and a hash only, `reason` is a short code, and backend error messages are dropped, because a
 * message can echo the prompt (FR-INN-16).
 *
 * Not in this task (see the ROADMAP): the `http` backend and the project/context override plumbing (T11.3; the pure gate
 * table is here because the pipeline must fail closed), task contracts (T11.4 onwards), usage accounting and the
 * `shares_subscription_with` observation (T11.5), and quality-window suspension with `inner_task_state` (T11.6; the
 * `fallback_suspended` outcome therefore is never produced yet).
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Ajv, type ValidateFunction } from "ajv";
import { createSecretRedactor, REDACTION_MARKER } from "../artifacts/redact.js";
import { CONTROLLER_ID } from "../git/sanitize.js";
import type { InnerCallEvents, InnerCallOutcome, InnerCallRow, NewInnerCall } from "../ledger/repo.js";
import { type BreakerAdmission, type BreakerState, type BreakerTransition, CircuitBreaker } from "./breaker.js";
import type { InnerAgentSettings, InnerTask, ProjectInnerSetting } from "./config.js";
import type { InnerBackend, InnerResult, Locality } from "./port.js";
import { truncateHeadTail } from "./truncate.js";

/** Closed list of re-ask error classes (LLD §13.4 step 9). The rejected text is never echoed back. */
export type ReaskClass = "not_json" | "schema" | "too_long" | "empty" | "rule";
export type { ProjectInnerSetting };

/** Per-task behaviour. Everything the pipeline cannot know generically lives here (LLD §13.6). */
export interface InnerTaskContract<T, F> {
  task: InnerTask;
  /** e.g. `commit_message.v1`; bumped on any prompt change. */
  template_version: string;
  /** Fixed template text, never built from input. */
  system: string;
  /** Output schema. The pipeline compiles it with Ajv; it should set `additionalProperties: false` (LLD §13.6). */
  response_schema: object;
  /** True when the input carries repository content (diffs, log excerpts), so the per-task opt-in applies (LLD §13.5). */
  sends_source_content: boolean;
  /** Rules beyond the schema. Return null when the value is fine, else any string (it is discarded, never logged). */
  validate?: (value: unknown) => string | null;
  /** Map the validated JSON to the value handed to the caller. Default: the parsed JSON itself. */
  accept?: (value: unknown) => T;
  /** `commit_message` and `pr_draft` only: the LLD §12.4 sanitiser. Return null when nothing usable is left. */
  sanitise?: (value: T) => T | null;
  /** Task-specific budget truncation (for example whole diff hunks). Default: head 25% and tail 75%. */
  truncate?: (text: string, budgetBytes: number) => { text: string; omitted: number };
  /** Hard cap on the raw completion, in bytes. Default `max_output_tokens * 4` (Assumption). */
  max_output_bytes?: number;
  /** The deterministic fallback (LLD §13.7). Must not depend on a second model call. */
  fallback: () => F;
  /**
   * Store an accepted value and return the ID of the artifact that holds it (the `pr_draft` artifact, T11.8). Runs after
   * the sanitiser and before the call is recorded, so the `inner_call` run event can reference the artifact (LLD §13.6).
   * A throw or a null result is `fallback_unavailable` (`PERSIST_FAILED`): the value is not handed out unstored.
   */
  persist?: (value: T) => Promise<string | null>;
  /** Bounded, non-body fields merged into the `inner_call` run event of an accepted call (for example `run_title`). */
  event_payload?: (value: T) => Record<string, unknown>;
}

/** The typed, controller-owned input already rendered to text by the task's input builder, plus call context. */
export interface InnerCallInput {
  /** Input text built by the task contract from controller-owned fields; redacted and budgeted by the pipeline. */
  user: string;
  run_id?: string | null;
  meta_session_id?: string | null;
  /** Effective project/context setting (T11.3 plumbs it from configuration). Default `inherit`. */
  project_setting?: ProjectInnerSetting;
  /** Provider-native session IDs to scrub from the prompt (LLD §12.4 `id.native-session`). */
  native_session_ids?: readonly string[];
  /** Artifact attached to the run event (a `pr_draft` or condensed-text artifact). */
  artifact_id?: string | null;
}

export type InnerCallResult<T, F> =
  | { accepted: true; value: T; outcome: "accepted"; call_id: string | undefined }
  | {
      accepted: false;
      fallback: F;
      /** `no_call`: the task is simply not enabled (nothing recorded, LLD §13.7 first row). */
      outcome: Exclude<InnerCallOutcome, "accepted"> | "no_call";
      reason: string | undefined;
      call_id: string | undefined;
    };

/** One structured log record: codes and counts only, by construction no body (FR-INN-16). */
export type InnerLogEntry = Record<string, string | number | boolean | null>;

export interface PipelineDeps {
  settings: InnerAgentSettings;
  backend: InnerBackend;
  /** Where `inner_call` rows and run events are written. Without one, nothing is recorded (tests, tooling). */
  ledger?: { recordInnerCall(input: NewInnerCall, events?: InnerCallEvents): InnerCallRow };
  logger?: (entry: InnerLogEntry) => void;
  /** Breaker clock in ms (injectable for tests). */
  now?: () => number;
  /** Configured provider names to scrub from prompts (LLD §13.4 step 2b). */
  providerNames?: readonly string[];
  /** Home directory to mask in prompts. Default `os.homedir()`. */
  homeDir?: string;
}

export interface InnerPipeline {
  call<T, F>(contract: InnerTaskContract<T, F>, input: InnerCallInput): Promise<InnerCallResult<T, F>>;
  readonly breakerState: BreakerState;
}

// ---- privacy gate (LLD §13.5) -------------------------------------------------------------------------------------

export interface GateInput {
  projectSetting: ProjectInnerSetting;
  locality: Locality;
  allowRemote: boolean;
  sendsSourceContent: boolean;
  allowSourceContent: boolean;
}
export type GateResult = { allowed: true } | { allowed: false; reason: string };

/** The seven-row table of LLD §13.5, evaluated top to bottom. */
export function evaluatePrivacyGate(g: GateInput): GateResult {
  if (g.projectSetting === "off") return { allowed: false, reason: "PROJECT_OFF" };
  if (g.locality === "local") return { allowed: true };
  if (g.projectSetting === "local_only") return { allowed: false, reason: "PROJECT_LOCAL_ONLY" };
  if (!g.allowRemote) return { allowed: false, reason: "REMOTE_NOT_ALLOWED" };
  if (g.sendsSourceContent && !g.allowSourceContent) return { allowed: false, reason: "SOURCE_CONTENT_NOT_ALLOWED" };
  return { allowed: true };
}

// ---- text handling ---------------------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls other than newline and tab is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;
const stripControls = (s: string) => s.replace(CONTROL, "");

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const dropLoneSurrogates = (s: string) => s.replace(new RegExp(LONE_SURROGATE.source, "gu"), "");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** LLD §13.4 step 2: telemetry redactor, identifier and path scrub, control-character stripping. Only removes or masks. */
export function redactInput(
  text: string,
  opts: { providerNames?: readonly string[]; nativeSessionIds?: readonly string[]; homeDir?: string } = {},
): string {
  // (a) credential-like values: the same component as telemetry and artifacts (FR-TEL-03), applied to the UTF-8 bytes.
  let out = createSecretRedactor()(Buffer.from(dropLoneSurrogates(text), "utf8")).toString("utf8");
  // home paths
  const home = opts.homeDir ?? homedir();
  if (home.length > 1) out = out.split(home).join("~");
  // (b) identifier scrub: controller IDs, native session IDs, configured provider names
  out = out.replace(new RegExp(CONTROLLER_ID.source, CONTROLLER_ID.flags), REDACTION_MARKER);
  for (const id of opts.nativeSessionIds ?? []) if (id.length > 0) out = out.split(id).join(REDACTION_MARKER);
  const names = [...(opts.providerNames ?? [])].filter((n) => n.length > 0);
  if (names.length > 0) {
    out = out.replace(
      new RegExp(`(?<![0-9A-Za-z])(?:${names.map(escapeRe).join("|")})(?![0-9A-Za-z])`, "giu"),
      "[provider]",
    );
  }
  // (c) control characters
  return stripControls(out);
}

function deepStrip(value: unknown): unknown {
  if (typeof value === "string") return stripControls(value);
  if (Array.isArray(value)) return value.map(deepStrip);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepStrip(v)]));
  }
  return value;
}

type Decoded = { ok: true; value: unknown; bytes: number } | { ok: false; cls: ReaskClass; bytes: number };

/** LLD §13.4 steps 8 and 9 (first half): UTF-8, byte cap, control stripping, single JSON value. */
function decode(text: string, maxBytes: number): Decoded {
  const bytes = Buffer.byteLength(text, "utf8");
  // The port hands us a JS string; a lone surrogate or U+FFFD is what a failed UTF-8 decode leaves behind.
  if (LONE_SURROGATE.test(text) || text.includes("\uFFFD")) return { ok: false, cls: "not_json", bytes };
  if (bytes > maxBytes) return { ok: false, cls: "too_long", bytes };
  const trimmed = stripControls(text).trim();
  if (trimmed === "") return { ok: false, cls: "empty", bytes };
  try {
    return { ok: true, value: deepStrip(JSON.parse(trimmed)), bytes };
  } catch {
    return { ok: false, cls: "not_json", bytes };
  }
}

const REASK_NOTE: Record<ReaskClass, string> = {
  not_json: "not_json",
  schema: "schema",
  too_long: "too_long",
  empty: "empty",
  rule: "rule",
};

// ---- concurrency -----------------------------------------------------------------------------------------------------

class Semaphore {
  private free: number;
  private readonly waiters: (() => void)[] = [];
  constructor(size: number) {
    this.free = size;
  }
  /** Resolves a release function, or undefined when `signal` aborted first. */
  acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
    const release = () => {
      const next = this.waiters.shift();
      if (next !== undefined) next();
      else this.free++;
    };
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(undefined);
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ---- the pipeline ----------------------------------------------------------------------------------------------------

class TransportFailure extends Error {
  constructor(readonly code: "TIMEOUT" | "BACKEND_ERROR") {
    super(code); // never the backend's own message: it may echo the prompt
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function createInnerPipeline(deps: PipelineDeps): InnerPipeline {
  const { settings, backend } = deps;
  const backendSettings = settings.backend;
  const breaker = new CircuitBreaker({
    failureThreshold: settings.breaker.failureThreshold,
    openMs: settings.breaker.openMs,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const slots = new Semaphore(backendSettings?.maxConcurrency ?? 1);
  const validators = new WeakMap<object, ValidateFunction>();
  const ajv = new Ajv({ allErrors: false, strict: true });
  const compile = (schema: object): ValidateFunction => {
    let v = validators.get(schema);
    if (v === undefined) {
      v = ajv.compile(schema);
      validators.set(schema, v);
    }
    return v;
  };
  const log = (entry: InnerLogEntry) => {
    try {
      deps.logger?.(entry);
    } catch {
      // a logger must never break a run
    }
  };

  async function call<T, F>(contract: InnerTaskContract<T, F>, input: InnerCallInput): Promise<InnerCallResult<T, F>> {
    const task = settings.tasks[contract.task];
    const fallbackOnly = (
      outcome: Exclude<InnerCallOutcome, "accepted"> | "no_call",
      reason?: string,
      callId?: string,
    ): InnerCallResult<T, F> => ({
      accepted: false,
      fallback: contract.fallback(),
      outcome,
      reason,
      call_id: callId,
    });
    // LLD §13.4 step 1: master switch, task switch (no row).
    if (!settings.enabled || !task.enabled || backendSettings === undefined) return fallbackOnly("no_call");

    const started = Date.now();
    const timeoutMs = Math.min(task.timeoutMs ?? backendSettings.timeoutMs, backendSettings.timeoutMs);
    const ctrl = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      ctrl.abort(new Error("deadline"));
    }, timeoutMs);
    const signal = ctrl.signal;

    // Everything that will be recorded, filled in as the pipeline advances.
    const rec = {
      locality: "remote" as Locality,
      modelId: backendSettings.model,
      attempts: 0,
      tokensIn: null as number | null,
      tokensOut: null as number | null,
      inputBytes: 0,
      outputBytes: 0,
      inputHash: sha256(""),
    };
    let transition: BreakerTransition | undefined;
    let transitionReason = "";
    let admission: BreakerAdmission = "allow";
    let admitted = false;
    let release: (() => void) | undefined;

    const race = <X>(p: Promise<X>): Promise<X> =>
      new Promise<X>((resolve, reject) => {
        const onAbort = () => reject(new TransportFailure("TIMEOUT"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        p.then(
          (v) => {
            signal.removeEventListener("abort", onAbort);
            resolve(v);
          },
          () => {
            signal.removeEventListener("abort", onAbort);
            reject(new TransportFailure(deadlineHit ? "TIMEOUT" : "BACKEND_ERROR"));
          },
        );
      });

    let persistedArtifactId: string | null = null;
    const finish = (outcome: InnerCallOutcome, reason: string | undefined, value?: T): InnerCallResult<T, F> => {
      const latency = rec.attempts === 0 ? 0 : Date.now() - started;
      let callId: string | undefined;
      const row: NewInnerCall = {
        task: contract.task,
        backend_kind: backend.kind,
        model_id: rec.modelId,
        locality: rec.locality,
        template_version: contract.template_version,
        outcome,
        reason: reason ?? null,
        attempts: rec.attempts,
        latency_ms: latency,
        tokens_in: rec.tokensIn,
        tokens_out: rec.tokensOut,
        input_bytes: rec.inputBytes,
        output_bytes: rec.outputBytes,
        input_sha256: rec.inputHash,
        run_id: input.run_id ?? null,
        meta_session_id: input.meta_session_id ?? null,
      };
      if (deps.ledger !== undefined) {
        try {
          const extra =
            transition === undefined
              ? []
              : [
                  {
                    type: "inner_degraded",
                    payload: {
                      state: transition,
                      reason: transitionReason,
                      breaker_state: breaker.state,
                      backend_kind: backend.kind,
                    },
                  },
                ];
          const callPayload =
            outcome === "accepted" && value !== undefined ? (contract.event_payload?.(value) ?? undefined) : undefined;
          callId = deps.ledger.recordInnerCall(row, {
            ...(callPayload !== undefined ? { callPayload } : {}),
            artifactId: input.artifact_id ?? persistedArtifactId,
            extra,
          }).id;
        } catch {
          log({ event: "inner.record_failed", task: contract.task, outcome });
        }
      }
      log({
        event: "inner.call",
        task: contract.task,
        outcome,
        reason: reason ?? null,
        attempts: rec.attempts,
        latency_ms: latency,
        input_bytes: rec.inputBytes,
        output_bytes: rec.outputBytes,
        locality: rec.locality,
        breaker_state: breaker.state,
        call_id: callId ?? null,
      });
      if (outcome === "accepted" && value !== undefined) {
        return { accepted: true, value, outcome, call_id: callId };
      }
      return fallbackOnly(outcome === "accepted" ? "fallback_unavailable" : outcome, reason, callId);
    };

    try {
      // Step 1 (gate): a project or context set to `off` needs no locality, so not even a name lookup happens.
      if (input.project_setting === "off") return finish("fallback_disabled", "PROJECT_OFF");
      // Locality is resolved under the deadline; failure to resolve is `remote` (fail closed).
      try {
        rec.locality = await race(backend.resolveLocality(signal));
      } catch (e) {
        if (e instanceof TransportFailure && e.code === "TIMEOUT") return finish("fallback_unavailable", "TIMEOUT");
        rec.locality = "remote";
      }
      const gate = evaluatePrivacyGate({
        projectSetting: input.project_setting ?? "inherit",
        locality: rec.locality,
        allowRemote: backendSettings.allowRemote,
        sendsSourceContent: contract.sends_source_content,
        allowSourceContent: task.allowSourceContent,
      });
      if (!gate.allowed) return finish("fallback_disabled", gate.reason);

      // Steps 2 to 4: redact, budget, hash.
      const redacted = redactInput(input.user, {
        ...(deps.providerNames !== undefined ? { providerNames: deps.providerNames } : {}),
        ...(input.native_session_ids !== undefined ? { nativeSessionIds: input.native_session_ids } : {}),
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      });
      const budgeted = (contract.truncate ?? truncateHeadTail)(redacted, task.inputBudgetBytes).text;
      rec.inputBytes = Buffer.byteLength(budgeted, "utf8");
      rec.inputHash = sha256(budgeted);

      // Step 5: slot, waiting no longer than the remaining bound.
      release = await slots.acquire(signal);
      if (release === undefined) return finish("fallback_unavailable", "BUSY");

      // Step 6: breaker.
      admission = breaker.admit();
      admitted = true;
      if (admission === "deny") {
        admitted = false;
        return finish("fallback_unavailable", "CIRCUIT_OPEN");
      }

      // Steps 7 to 9: call, decode, validate, at most one re-ask.
      const validate = compile(contract.response_schema);
      const maxBytes = contract.max_output_bytes ?? task.maxOutputTokens * 4;
      let user = budgeted;
      let lastClass: ReaskClass = "rule";
      let tokIn: number | null = 0;
      let tokOut: number | null = 0;
      let parsed: unknown;
      let valid = false;
      for (let attempt = 1; attempt <= 2 && !valid; attempt++) {
        if (attempt === 2 && signal.aborted) break; // no time left for the re-ask
        rec.attempts = attempt;
        let result: InnerResult;
        try {
          result = await race(
            backend.complete(
              {
                task: contract.task,
                template_version: contract.template_version,
                system: contract.system,
                user,
                max_output_tokens: task.maxOutputTokens,
                response_schema: contract.response_schema,
              },
              signal,
            ),
          );
          if (result === null || typeof result !== "object" || typeof result.text !== "string") {
            throw new TransportFailure("BACKEND_ERROR"); // unreadable envelope
          }
        } catch (e) {
          const code = e instanceof TransportFailure ? e.code : "BACKEND_ERROR";
          transition = breaker.failure(admission);
          transitionReason = code;
          admitted = false;
          return finish("fallback_unavailable", code);
        }
        const t = breaker.success(admission);
        admission = "allow"; // the probe (if any) is settled; a re-ask is an ordinary call on a closed circuit
        admitted = false;
        if (t !== undefined) transition = t;
        if (typeof result.model_id === "string" && result.model_id !== "") rec.modelId = result.model_id;
        tokIn = tokIn !== null && result.usage?.in != null ? tokIn + result.usage.in : null;
        tokOut = tokOut !== null && result.usage?.out != null ? tokOut + result.usage.out : null;
        rec.tokensIn = tokIn;
        rec.tokensOut = tokOut;

        const decoded = decode(result.text, maxBytes);
        rec.outputBytes = decoded.bytes;
        if (!decoded.ok) {
          lastClass = decoded.cls;
        } else if (!validate(decoded.value)) {
          lastClass = "schema";
        } else if (contract.validate?.(decoded.value) != null) {
          lastClass = "rule";
        } else {
          parsed = decoded.value;
          valid = true;
          break;
        }
        user = `${budgeted}\n\n[previous answer rejected: ${REASK_NOTE[lastClass]}]`;
      }
      if (!valid) return finish("rejected_validator", lastClass.toUpperCase());

      // Step 10: sanitiser (commit_message and pr_draft only).
      let value: T = contract.accept !== undefined ? contract.accept(parsed) : (parsed as T);
      if (contract.sanitise !== undefined) {
        const clean = contract.sanitise(value);
        if (clean === null) return finish("rejected_sanitiser", "EMPTY_AFTER_SANITISER");
        value = clean;
      }
      if (contract.persist !== undefined) {
        let id: string | null = null;
        try {
          id = await contract.persist(value);
        } catch {
          id = null;
        }
        if (id === null) return finish("fallback_unavailable", "PERSIST_FAILED");
        persistedArtifactId = id;
      }
      // Step 11 (suspension) is T11.6.
      return finish("accepted", undefined, value);
    } catch {
      // Every step is wrapped: an exception inside the pipeline is `fallback_unavailable`, never a throw (LLD §13.4).
      log({ event: "inner.pipeline_exception", task: contract.task });
      try {
        return finish("fallback_unavailable", "PIPELINE_ERROR");
      } catch {
        return fallbackOnly("fallback_unavailable", "PIPELINE_ERROR");
      }
    } finally {
      clearTimeout(timer);
      if (admitted) breaker.abandon(admission);
      release?.();
    }
  }

  return {
    call,
    get breakerState() {
      return breaker.state;
    },
  };
}
