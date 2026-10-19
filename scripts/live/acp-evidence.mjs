/**
 * Pure evidence helpers for the Kimi Code live checks of T4.68 (owner ruling relayed 2026-10-19 02:42 CT, ROADMAP §4.2
 * decision 74). They live outside `scripts/live/providers/` because `scripts/live-smoke.mjs` treats every `.mjs` file
 * there as a plug-in. Both helpers read records only and print no value: field NAMES, counts and kinds, never a tool
 * argument, a prompt or provider text.
 *
 * - {@link permissionRoundTrip} (check `K-P1`): for one ACP run, the `session/request_permission` requests in the
 *   stored (redacted) provider stream and the controller's `acp_permission` run events in the ledger. It fails closed:
 *   a run whose stream holds no permission request FAILS, never passes.
 * - {@link failedTurnVerdict} (check `K-F1`): one deliberately failed turn in the `--prompt` cell (a `--session` id no
 *   session can have) and the CLI's own exit code, kept apart from the script's exit code. Exit 0 on that turn FAILS.
 */

/** ACP `ToolCall` fields read as the tool call's name (ACP v1 names it `title`; `name` is accepted too). */
export const TOOL_NAME_FIELDS = Object.freeze(["title", "name"]);
/** ACP `ToolCall` fields read as the tool call's arguments (ACP v1 `rawInput`; `arguments` and `input` too). */
export const TOOL_ARGUMENT_FIELDS = Object.freeze(["rawInput", "arguments", "input"]);
/** The controller's two answers K-P1 accepts (`src/policy/acp-permission.ts`; never `allow_always`). */
export const PERMISSION_OPTION_KINDS = Object.freeze(["allow_once", "reject_once"]);
/** The `run_event.type` the ACP client writes per answered permission request (`src/exec/acp/client.ts`). */
export const ACP_PERMISSION_EVENT = "acp_permission";
/** Prefix of the forced-failure session id: safe as one argv word, and no Kimi session id has this shape. */
export const FORCED_SESSION_PREFIX = "sb-forced-fail-";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o, fields) => fields.some((f) => Object.hasOwn(o, f) && o[f] !== null && o[f] !== "");

/** A `--session` id for the forced failed turn from `hex` (random hex digits; the caller draws them). Pure. */
export function forcedSessionId(hex) {
  if (!/^[0-9a-f]{8,64}$/.test(hex)) throw new Error("forcedSessionId: hex digits expected");
  return `${FORCED_SESSION_PREFIX}${hex}`;
}

/**
 * The `session/request_permission` requests of one stored ACP stream, one record per request, in order: the sorted
 * field names of `params.toolCall` and whether it carries a name and arguments. Lines that are not JSON-RPC requests
 * are ignored. Pure.
 */
export function permissionRequests(streamText) {
  const out = [];
  for (const line of String(streamText).split("\n")) {
    if (line.trim() === "") continue;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(doc) || doc.method !== "session/request_permission" || doc.id === undefined) continue;
    const toolCall = isObj(doc.params) && isObj(doc.params.toolCall) ? doc.params.toolCall : undefined;
    out.push({
      toolCallFields: toolCall ? Object.keys(toolCall).sort() : [],
      hasName: toolCall !== undefined && has(toolCall, TOOL_NAME_FIELDS),
      hasArguments: toolCall !== undefined && has(toolCall, TOOL_ARGUMENT_FIELDS),
    });
  }
  return out;
}

/**
 * The `session/update` `tool_call` and `tool_call_update` records of one stored ACP stream (a count only). With no
 * permission request, it tells "tools ran without asking" from "the turn never reached a tool call". Pure.
 */
export function toolCallUpdates(streamText) {
  let count = 0;
  for (const line of String(streamText).split("\n")) {
    if (line.trim() === "") continue;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(doc) || doc.method !== "session/update" || !isObj(doc.params) || !isObj(doc.params.update)) continue;
    const variant = doc.params.update.sessionUpdate;
    if (variant === "tool_call" || variant === "tool_call_update") count += 1;
  }
  return count;
}

/**
 * The controller's answers of one run from its `run_event` rows (`type`, `payload_json`), in order: the
 * `option_kind` of each `acp_permission` event (`cancelled` when the answer selected no option). Pure.
 */
export function permissionAnswers(runEvents) {
  const out = [];
  for (const e of runEvents ?? []) {
    if (e?.type !== ACP_PERMISSION_EVENT) continue;
    let p;
    try {
      p = JSON.parse(e.payload_json);
    } catch {
      p = undefined;
    }
    out.push(typeof p?.option_kind === "string" ? p.option_kind : "cancelled");
  }
  return out;
}

/**
 * K-P1 for one ACP run. `ran` is false when the provider never produced a stream (NOT_CHECKED: no evidence either
 * way). Otherwise HELD only when ALL of these hold, and FAILED on the first that does not:
 *   1. the stream holds at least one `session/request_permission` (none: FAILED, the fail-closed rule, whether or
 *      not a tool call was observed; the evidence says which, as `tool_call_updates` in `record`);
 *   2. every request's `toolCall` carries a name and arguments;
 *   3. the ledger holds one `acp_permission` answer per request;
 *   4. every answer is `allow_once` or `reject_once`.
 * `record` is the evidence for the summary file (counts, field names and option kinds only). Pure.
 */
export function permissionRoundTrip({ ran, stream, runEvents }) {
  const requests = ran ? permissionRequests(stream ?? "") : [];
  const answers = ran ? permissionAnswers(runEvents) : [];
  const toolCalls = ran ? toolCallUpdates(stream ?? "") : 0;
  const record = {
    requests: requests.length,
    tool_call_updates: toolCalls,
    tool_call_fields: [...new Set(requests.flatMap((r) => r.toolCallFields))].sort(),
    with_name: requests.filter((r) => r.hasName).length,
    with_arguments: requests.filter((r) => r.hasArguments).length,
    answers: answers.length,
    option_kinds: answers,
  };
  const counts = `${record.requests} request(s), ${record.with_name} with a name, ${record.with_arguments} with arguments`;
  const kinds = `answers [${answers.join(", ")}]`;
  const fields = `toolCall fields [${record.tool_call_fields.join(", ")}]`;
  if (!ran) return { result: "NOT_CHECKED", evidence: "provider never ran", record };
  if (requests.length === 0) {
    return {
      result: "FAILED",
      evidence:
        toolCalls > 0
          ? `no session/request_permission in the stream, ${toolCalls} tool_call update(s): the default mode did not ask (fail closed)`
          : "no session/request_permission and no tool_call update in the stream: the turn never reached a tool call, so the round trip was not exercised (fail closed)",
      record,
    };
  }
  if (record.with_name !== requests.length || record.with_arguments !== requests.length) {
    return { result: "FAILED", evidence: `a request lacks the tool name or arguments: ${counts}; ${fields}`, record };
  }
  if (answers.length !== requests.length) {
    return {
      result: "FAILED",
      evidence: `${counts}, but ${answers.length} controller answer(s) in the ledger`,
      record,
    };
  }
  const bad = answers.filter((k) => !PERMISSION_OPTION_KINDS.includes(k));
  if (bad.length > 0) {
    return {
      result: "FAILED",
      evidence: `${bad.length} answer(s) neither allow_once nor reject_once; ${kinds}`,
      record,
    };
  }
  return { result: "HELD", evidence: `${counts}; ${kinds}; ${fields}`, record };
}

/**
 * K-F1: the deliberately failed turn. `spawned` is false when no CLI process ran (compile Ineligible, audit refused,
 * binary missing): NOT_CHECKED with `reason`. Otherwise, with `exitCode` the CLI's own exit code (null when it was
 * ended by a signal) and `turnFailed` whether the adapter classified the turn as failed:
 *   - the turn did not fail (the CLI accepted the session id): FAILED, the failure was not forced;
 *   - exit code 0, or no exit code (signal, timeout): FAILED;
 *   - otherwise HELD: the CLI reported the failed turn with a non-zero exit code.
 * `record` keeps the CLI exit code separate from the script's own exit code. Pure.
 */
export function failedTurnVerdict({ spawned, reason, exitCode, signal, turnFailed, failureCode }) {
  const record = {
    cli_exit_code: spawned ? (exitCode ?? null) : null,
    cli_signal: spawned ? (signal ?? null) : null,
    turn_failed: spawned ? turnFailed === true : null,
    failure_code: spawned ? (failureCode ?? null) : null,
  };
  if (!spawned) return { result: "NOT_CHECKED", evidence: reason ?? "no CLI process ran", record };
  const exit = `CLI exit code ${exitCode ?? "none"}${signal ? ` (signal ${signal})` : ""}`;
  if (turnFailed !== true) {
    return { result: "FAILED", evidence: `the forced turn did not fail (${exit}): no failure was forced`, record };
  }
  if (typeof exitCode !== "number") {
    return { result: "FAILED", evidence: `${exit}: the CLI did not exit on its own`, record };
  }
  if (exitCode === 0) {
    return { result: "FAILED", evidence: `${exit} on a failed turn (${failureCode ?? "failed"})`, record };
  }
  return { result: "HELD", evidence: `${exit} on a failed turn (${failureCode ?? "failed"})`, record };
}
