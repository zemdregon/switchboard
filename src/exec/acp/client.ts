/**
 * Per-run ACP stdio client (FR-EXE-03; ADR-0036, Proposed; LLD §8.2; ROADMAP T4.8). Delegated agent work, not
 * owner-approved; every numeric bound is a Proposed target.
 *
 * One agent process per run, spawned by the run supervisor (`../supervisor.ts`: own process group, allowlisted
 * environment, wall-clock and idle timeouts, 1 MiB line bound, SIGTERM-then-SIGKILL), with stdin kept open. The client:
 * - sends `initialize` (version 1; `fs.readTextFile`, `fs.writeTextFile` and `terminal` all `false`; `clientInfo`),
 *   within {@link ACP_INITIALIZE_TIMEOUT_MS}; any other `protocolVersion` is `OUTPUT_PROTOCOL_ERROR`;
 * - never sends `authenticate` or `logout` and never runs a login; `-32000` on any request ends the run `AUTH_REQUIRED`;
 * - opens the session with `session/new`, or for a resume `session/resume` (if `sessionCapabilities.resume` was
 *   advertised) else `session/load` (if `loadSession`), else ends `TOOL_FAILURE` (`acp_resume_unsupported`), within
 *   {@link ACP_SESSION_TIMEOUT_MS}; updates replayed by `session/load` are counted, not turned into events;
 * - sends the plan's `session/set_mode` and `session/set_config_option` values (audited before spawn), then exactly one
 *   `session/prompt` with one `text` block;
 * - answers `session/request_permission` at once through the injected decision (`decidePermission`, ADR-0036 item 9),
 *   rejecting when it throws or misses {@link ACP_PERMISSION_DECISION_MS}; refuses every other agent request with
 *   `-32601`; never selects `allow_always`;
 * - on the `session/prompt` result or error, closes stdin, waits `killGraceMs`, then kills the group;
 * - on cancel or a wall-clock or idle timeout, answers pending permission requests `cancelled`, sends `session/cancel`
 *   and waits up to `killGraceMs` for the result before the group kill (the kill never waits on the agent).
 *
 * Names are from the ACP specification v1 (agentclientprotocol.com, retrieved 2026-10-13, tags as in ADR-0036). The
 * permission response is sent as `result: {outcome: {outcome: "selected", optionId}}` or `{outcome: {outcome:
 * "cancelled"}}` (the outcome object of [ACP-TC] inside the `RequestPermissionResponse` result); the `current_mode_update`
 * field read is `currentModeId` ([ACP-MODE]). How real providers behave behind these names is Unverified until each
 * provider's operator capture (ADR-0036 "Revisit when").
 */
import type { AcpMessage, AcpPlan, NormalizedEvent } from "../../adapters/types.js";
import { type AcpPermissionDecision, rejectionFor } from "../../policy/acp-permission.js";
import {
  type ProtocolErrorInfo,
  type SupervisedResult,
  type SupervisedRun,
  type SuperviseOptions,
  supervise,
} from "../supervisor.js";
import { acpErrorEvent } from "./events.js";
import { type AcpId, classifyEnvelope, encodeMessage } from "./framing.js";

/** ADR-0036 item 4 (Proposed): `initialize` answered within 30 s, the preflight probe target. */
export const ACP_INITIALIZE_TIMEOUT_MS = 30_000;
/** ADR-0036 item 4 (Proposed): session setup (may start MCP servers) within 60 s. */
export const ACP_SESSION_TIMEOUT_MS = 60_000;
/** ADR-0036 item 9.1 (Proposed): a permission decision not returned within 1 s is a rejection. */
export const ACP_PERMISSION_DECISION_MS = 1_000;
/** ADR-0036 item 3 (Proposed): more unanswered agent-to-client requests than this is `OUTPUT_PROTOCOL_ERROR`. */
export const ACP_MAX_PENDING_AGENT_REQUESTS = 8;
/** ADR-0036 item 9.6: at most this many `acp_permission` events per run; the rest are counted in one final event. */
export const ACP_MAX_PERMISSION_EVENTS = 256;
/** JSON-RPC "method not found", the answer to every agent request but permission requests (ADR-0036 item 11). */
export const ACP_METHOD_NOT_FOUND = -32601;

/** New run event types (ADR-0036 Consequences; LLD §2). Payloads are bounded and never hold agent text. */
export const ACP_INITIALIZED_EVENT = "acp_initialized";
export const ACP_PERMISSION_EVENT = "acp_permission";
export const ACP_REQUEST_REFUSED_EVENT = "acp_request_refused";

export interface AcpRunEvent {
  readonly type: typeof ACP_INITIALIZED_EVENT | typeof ACP_PERMISSION_EVENT | typeof ACP_REQUEST_REFUSED_EVENT;
  readonly payload: Record<string, unknown>;
}

export type AcpDecide = (params: unknown) => AcpPermissionDecision | Promise<AcpPermissionDecision>;

export interface AcpRunOptions
  extends Pick<
    SuperviseOptions,
    "argv" | "cwd" | "envAllowlist" | "extraEnv" | "baseEnv" | "wallClockMs" | "idleMs" | "killGraceMs" | "onSpawn"
  > {
  readonly maxLineBytes?: number;
  readonly maxCaptureBytes?: number;
  readonly plan: AcpPlan;
  /** The adapter's `parseEvent` for `session/update` notifications and the `session/prompt` response. */
  readonly parse: (msg: AcpMessage) => NormalizedEvent[];
  readonly onEvent?: (event: NormalizedEvent) => void;
  readonly onRunEvent?: (event: AcpRunEvent) => void;
  /** The permission decision (normally `decidePermission` over the frozen snapshot). */
  readonly decide: AcpDecide;
  /** Tool call ids the client rejected; shared with the parse state so their `tool_call` events say `denied`. */
  readonly deniedToolCallIds: Set<string>;
  /** Declared bypass-class mode ids of the provider (ADR-0036 item 10). */
  readonly bypassModeIds?: readonly string[];
  /** True only in an approved bypass run (privileged, bypassApproved, scope sets bypass). */
  readonly approvedBypass: boolean;
  readonly initializeTimeoutMs?: number;
  readonly sessionTimeoutMs?: number;
  readonly permissionDecisionMs?: number;
  readonly maxPendingAgentRequests?: number;
  /** Clock for the decision bound (tests). */
  readonly now?: () => number;
  /** `clientInfo.version`. */
  readonly clientVersion?: string;
}

export interface AcpRunResult extends SupervisedResult {
  /** Every message the client wrote, one per line (for the `provider_stdin` artifact, after the redactor). */
  readonly sent: Buffer;
  /** True once the `session/prompt` response (result or error) arrived. */
  readonly turnEnded: boolean;
  /** `session/update` notifications replayed by `session/load` (counted, not turned into events; item 7.2). */
  readonly replayedUpdates: number;
}

export interface AcpRun {
  readonly pid: number | undefined;
  readonly pgid: number | undefined;
  cancel(): Promise<void>;
  readonly result: Promise<AcpRunResult>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const bound = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
/** Proposed bound on a native session id taken from `session/new` (longer is a protocol error). */
const MAX_SESSION_ID_CHARS = 256;
const MAX_SENT_BYTES = 16 * 1024 * 1024;

/** Boolean capability flags only, at most 3 levels and 32 keys per level (no other agent data is recorded). */
function capabilityFlags(v: unknown, depth = 0): Json {
  const out: Json = {};
  if (!isObj(v) || depth > 2) return out;
  for (const [k, val] of Object.entries(v).slice(0, 32)) {
    const key = bound(k, 64);
    if (typeof val === "boolean") out[key] = val;
    else if (isObj(val)) out[key] = capabilityFlags(val, depth + 1);
  }
  return out;
}

/** Ids and types of the advertised auth methods, never any other auth data (ADR-0036 item 5). */
function authMethodIds(v: unknown): Array<{ id: string; type?: string }> {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 16).flatMap((m) => {
    if (!isObj(m) || typeof m.id !== "string") return [];
    return [{ id: bound(m.id, 64), ...(typeof m.type === "string" ? { type: bound(m.type, 32) } : {}) }];
  });
}

/** Runs one ACP agent process for one run. `result` never rejects. */
export function runAcpAgent(opts: AcpRunOptions): AcpRun {
  const plan = opts.plan;
  const killGraceMs = opts.killGraceMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const decisionMs = opts.permissionDecisionMs ?? ACP_PERMISSION_DECISION_MS;
  const maxPending = opts.maxPendingAgentRequests ?? ACP_MAX_PENDING_AGENT_REQUESTS;

  let run: SupervisedRun | undefined;
  const sent: Buffer[] = [];
  let sentBytes = 0;
  let nextId = 0;
  const pending = new Map<AcpId, string>(); // our request id -> method
  /** Agent permission requests not yet answered: id -> params. */
  const unanswered = new Map<AcpId, unknown>();
  let lineNumber = 0;
  let sessionId: string | undefined;
  let expectedSessionId: string | undefined;
  let replaying = false;
  let replayed = 0;
  let promptId: AcpId | undefined;
  let turnEnded = false;
  let done = false; // no further message is acted on (result, error, protocol failure)
  let cancelling = false;
  let completedByClient = false;
  let permissionEvents = 0;
  let permissionSuppressed = 0;
  const setupSteps: Array<[string, Json]> = [];
  const timers = new Set<NodeJS.Timeout>();
  let initTimer: NodeJS.Timeout | undefined;
  let sessionTimer: NodeJS.Timeout | undefined;
  let turnEndWaiters: Array<() => void> = [];

  const later = (ms: number, fn: () => void): NodeJS.Timeout => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const clear = (t: NodeJS.Timeout | undefined) => {
    if (t === undefined) return;
    clearTimeout(t);
    timers.delete(t);
  };

  const emit = (events: readonly NormalizedEvent[]) => {
    for (const e of events) opts.onEvent?.(e);
  };
  const runEvent = (type: AcpRunEvent["type"], payload: Json) => opts.onRunEvent?.({ type, payload });

  const write = (message: Json) => {
    const line = encodeMessage(message);
    if (sentBytes < MAX_SENT_BYTES) {
      const b = Buffer.from(line, "utf8");
      sent.push(b);
      sentBytes += b.length;
    }
    run?.writeStdin(line);
  };
  const request = (method: string, params: Json): AcpId => {
    nextId += 1;
    const id = nextId;
    pending.set(id, method);
    write({ id, method, params });
    return id;
  };
  const notify = (method: string, params: Json) => write({ method, params });

  const protocolError = (kind: string, message: string) => {
    if (done) return;
    done = true;
    const error: ProtocolErrorInfo = { kind, lineNumber, message };
    run?.fail({ kind: "protocol_error", error });
  };

  /** The turn is over (result, error or a setup failure): close stdin, grace, group kill (ADR-0036 item 8.4). */
  const endRun = () => {
    if (completedByClient) return;
    done = true;
    completedByClient = true;
    clear(initTimer);
    clear(sessionTimer);
    for (const w of turnEndWaiters) w();
    turnEndWaiters = [];
    void run?.complete();
  };

  const endWithError = (error: unknown) => {
    emit([acpErrorEvent(error, plan.loginCommand)]);
    endRun();
  };

  /** Ends the turn early (no reject option, or a bypass-class mode): `session/cancel`, then wait for the result. */
  const cancelTurn = () => {
    if (cancelling || done) return;
    cancelling = true;
    answerUnansweredCancelled();
    if (sessionId !== undefined && promptId !== undefined && !turnEnded) {
      notify("session/cancel", { sessionId });
      later(killGraceMs, endRun);
    } else endRun();
  };

  const respond = (id: AcpId, body: { result: unknown } | { error: { code: number; message: string } }) =>
    write({ id, ...body });

  function answerUnansweredCancelled(): void {
    for (const [id] of unanswered) {
      respond(id, { result: { outcome: { outcome: "cancelled" } } });
      recordPermission(undefined, { answer: "cancel_turn", reason: "run_cancelling", denied: "run_cancelling" }, 0);
    }
    unanswered.clear();
  }

  function recordPermission(toolCall: Json | undefined, d: AcpPermissionDecision, locationCount: number): void {
    if (permissionEvents >= ACP_MAX_PERMISSION_EVENTS) {
      permissionSuppressed += 1;
      return;
    }
    permissionEvents += 1;
    const kind = typeof toolCall?.kind === "string" ? bound(toolCall.kind, 32) : null;
    runEvent(ACP_PERMISSION_EVENT, {
      tool_kind: kind,
      decision: d.answer,
      reason: bound(d.answer === "cancel_turn" ? d.denied : d.reason, 64),
      option_kind: d.answer === "cancel_turn" ? null : d.answer,
      location_count: locationCount,
    });
  }

  const startSession = (caps: Json) => {
    const cwd = opts.cwd ?? process.cwd();
    const mcpServers = plan.mcpServers;
    if (plan.session.kind === "new") {
      request("session/new", { cwd, mcpServers });
    } else {
      const id = plan.session.nativeSessionId;
      const sessionCaps = isObj(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
      if (sessionCaps.resume !== undefined && sessionCaps.resume !== null && sessionCaps.resume !== false) {
        expectedSessionId = id;
        request("session/resume", { sessionId: id, cwd, mcpServers });
      } else if (caps.loadSession === true) {
        expectedSessionId = id;
        replaying = true;
        request("session/load", { sessionId: id, cwd, mcpServers });
      } else {
        emit([{ kind: "provider_error", category: "tool", message: "acp_resume_unsupported" }]);
        endRun();
        return;
      }
    }
    sessionTimer = later(opts.sessionTimeoutMs ?? ACP_SESSION_TIMEOUT_MS, () => {
      if (done) return;
      done = true;
      run?.fail({ kind: "timeout", timeoutKind: "acp_session" });
    });
  };

  const nextSetupOrPrompt = () => {
    const step = setupSteps.shift();
    if (step) {
      request(step[0], step[1]);
      return;
    }
    promptId = request("session/prompt", {
      sessionId: sessionId as string,
      prompt: [{ type: "text", text: plan.prompt }],
    });
  };

  const sessionReady = (id: string) => {
    clear(sessionTimer);
    sessionId = id;
    expectedSessionId = id;
    emit([{ kind: "session_bound", nativeSessionId: id }]);
    if (plan.modeId !== undefined) setupSteps.push(["session/set_mode", { sessionId: id, modeId: plan.modeId }]);
    for (const o of plan.configOptions ?? []) {
      setupSteps.push(["session/set_config_option", { sessionId: id, configId: o.configId, value: o.value }]);
    }
    nextSetupOrPrompt();
  };

  const onResponse = (method: string, msg: { result?: unknown; error?: unknown; id: AcpId | null }) => {
    if (method === "session/prompt") {
      turnEnded = true;
      const message: AcpMessage = {
        jsonrpc: "2.0",
        id: msg.id,
        ...(msg.error !== undefined ? { error: msg.error } : { result: msg.result }),
      };
      emit(opts.parse(message));
      endRun();
      return;
    }
    if (msg.error !== undefined) {
      endWithError(msg.error);
      return;
    }
    const result = isObj(msg.result) ? msg.result : undefined;
    switch (method) {
      case "initialize": {
        clear(initTimer);
        if (result?.protocolVersion !== 1) {
          protocolError("protocol_version", `initialize answered protocol version ${String(result?.protocolVersion)}`);
          return;
        }
        const caps = isObj(result.agentCapabilities) ? result.agentCapabilities : {};
        runEvent(ACP_INITIALIZED_EVENT, {
          protocol_version: 1,
          agent_capabilities: capabilityFlags(caps),
          auth_methods: authMethodIds(result.authMethods),
        });
        startSession(caps);
        return;
      }
      case "session/new": {
        const id = result?.sessionId;
        if (typeof id !== "string" || id === "" || id.length > MAX_SESSION_ID_CHARS) {
          protocolError("session_id", "session/new returned no usable sessionId");
          return;
        }
        sessionReady(id);
        return;
      }
      case "session/resume":
      case "session/load":
        replaying = false;
        sessionReady(expectedSessionId as string);
        return;
      default:
        nextSetupOrPrompt();
    }
  };

  const onPermissionRequest = (id: AcpId, params: unknown) => {
    const p = isObj(params) ? params : {};
    if (sessionId === undefined || p.sessionId !== sessionId) {
      protocolError("session_mismatch", "permission request for another session");
      return;
    }
    if (unanswered.size >= maxPending) {
      protocolError("too_many_pending_requests", `more than ${maxPending} unanswered agent requests`);
      return;
    }
    const toolCall = isObj(p.toolCall) ? p.toolCall : undefined;
    const locationCount = Array.isArray(toolCall?.locations) ? toolCall.locations.length : 0;
    if (cancelling) {
      respond(id, { result: { outcome: { outcome: "cancelled" } } });
      recordPermission(toolCall, { answer: "cancel_turn", reason: "run_cancelling", denied: "run_cancelling" }, 0);
      return;
    }
    unanswered.set(id, params);
    const apply = (d: AcpPermissionDecision) => {
      if (!unanswered.has(id) || done) return; // answered meanwhile (cancel) or the run is over
      unanswered.delete(id);
      recordPermission(toolCall, d, locationCount);
      const toolCallId = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : undefined;
      if (d.answer === "allow_once" || d.answer === "reject_once") {
        respond(id, { result: { outcome: { outcome: "selected", optionId: d.optionId } } });
      } else {
        respond(id, { result: { outcome: { outcome: "cancelled" } } });
      }
      if (d.answer !== "allow_once") {
        if (toolCallId !== undefined) opts.deniedToolCallIds.add(toolCallId);
        const kind = typeof toolCall?.kind === "string" ? bound(toolCall.kind, 32) : "unknown";
        emit([{ kind: "permission_denied", tool: kind }]);
      }
      if (d.answer === "cancel_turn") cancelTurn();
    };
    const started = now();
    let d: AcpPermissionDecision | Promise<AcpPermissionDecision>;
    try {
      d = opts.decide(params);
    } catch {
      apply(rejectionFor(params, "decision_error"));
      return;
    }
    if (d instanceof Promise) {
      const t = later(decisionMs, () => apply(rejectionFor(params, "decision_timeout")));
      d.then(
        (v) => {
          clear(t);
          apply(now() - started > decisionMs ? rejectionFor(params, "decision_timeout") : v);
        },
        () => {
          clear(t);
          apply(rejectionFor(params, "decision_error"));
        },
      );
      return;
    }
    apply(now() - started > decisionMs ? rejectionFor(params, "decision_timeout") : d);
  };

  const onValue = (value: unknown, line: number) => {
    lineNumber = line;
    if (done) return;
    const env = classifyEnvelope(value);
    switch (env.kind) {
      case "invalid":
        protocolError(env.reason, `line ${line}: ${env.reason}`);
        return;
      case "response": {
        const method = env.id === null ? undefined : pending.get(env.id);
        if (method === undefined || env.id === null) {
          protocolError("unknown_response_id", `line ${line}: response to an id the client did not send`);
          return;
        }
        pending.delete(env.id);
        onResponse(method, env);
        return;
      }
      case "request":
        if (env.method === "session/request_permission") {
          onPermissionRequest(env.id, env.params);
          return;
        }
        // ADR-0036 item 11: no client capability is advertised, so every other request is refused at once.
        respond(env.id, { error: { code: ACP_METHOD_NOT_FOUND, message: "Method not found" } });
        runEvent(ACP_REQUEST_REFUSED_EVENT, { method: bound(env.method, 64) });
        return;
      case "notification": {
        if (env.method !== "session/update") {
          emit([{ kind: "unknown", rawType: bound(env.method, 64) }]);
          return;
        }
        const params = isObj(env.params) ? env.params : {};
        if (expectedSessionId === undefined || params.sessionId !== expectedSessionId) {
          protocolError("session_mismatch", `line ${line}: update for another session`);
          return;
        }
        if (replaying) {
          replayed += 1; // ADR-0036 item 7.2: kept in the raw artifact, not this run's events
          return;
        }
        const update = isObj(params.update) ? params.update : {};
        if (update.sessionUpdate === "current_mode_update" && !opts.approvedBypass) {
          const mode = typeof update.currentModeId === "string" ? update.currentModeId : undefined;
          if (mode !== undefined && (opts.bypassModeIds ?? []).includes(mode)) {
            emit([{ kind: "permission_denied", tool: "acp_bypass_mode" }]);
            cancelTurn();
            return;
          }
        }
        emit(opts.parse({ jsonrpc: "2.0", method: env.method, params: env.params }));
        return;
      }
    }
  };

  /** ADR-0036 item 8.5, run by the supervisor before the group kill on cancel and on the wall-clock or idle timer. */
  const graceful = async (): Promise<void> => {
    cancelling = true;
    answerUnansweredCancelled();
    if (done || sessionId === undefined || promptId === undefined || turnEnded) return;
    notify("session/cancel", { sessionId });
    await new Promise<void>((resolve) => {
      turnEndWaiters.push(resolve);
    });
  };

  run = supervise({
    argv: opts.argv,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    envAllowlist: opts.envAllowlist,
    ...(opts.extraEnv ? { extraEnv: opts.extraEnv } : {}),
    ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
    ...(opts.wallClockMs !== undefined ? { wallClockMs: opts.wallClockMs } : {}),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    killGraceMs,
    ...(opts.maxLineBytes !== undefined ? { maxLineBytes: opts.maxLineBytes } : {}),
    ...(opts.maxCaptureBytes !== undefined ? { maxCaptureBytes: opts.maxCaptureBytes } : {}),
    ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
    keepStdinOpen: true,
    rejectBlankLines: true,
    onEvent: onValue,
    beforeTerminate: graceful,
  });

  if (run.pid !== undefined) {
    request("initialize", {
      protocolVersion: plan.protocolVersion,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "switchboard", version: opts.clientVersion ?? "0.0.0" },
    });
    initTimer = later(opts.initializeTimeoutMs ?? ACP_INITIALIZE_TIMEOUT_MS, () => {
      if (done) return;
      done = true;
      run?.fail({ kind: "timeout", timeoutKind: "acp_initialize" });
    });
  }

  const supervised = run;
  const result = supervised.result.then((r): AcpRunResult => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const w of turnEndWaiters) w();
    turnEndWaiters = [];
    if (permissionSuppressed > 0) {
      runEvent(ACP_PERMISSION_EVENT, { summary: true, suppressed: permissionSuppressed });
    }
    // ADR-0036 item 8.4: an exit the client did not bring about, before the turn ended, is a crash.
    const crashed = r.outcome === "exited" && !completedByClient && !turnEnded;
    return {
      ...r,
      ...(crashed ? { outcome: "crashed" as const, failureCode: "PROCESS_CRASH" as const } : {}),
      sent: Buffer.concat(sent),
      turnEnded,
      replayedUpdates: replayed,
    };
  });

  return {
    pid: supervised.pid,
    pgid: supervised.pgid,
    cancel: () => supervised.cancel(),
    result,
  };
}
