/**
 * `environment` run events into the ledger (FR-PRJ-07, LLD §4 `run_event.type` `environment`, LLD §11.3; T10.2). The
 * environment port stays ledger-free: an environment emits to its `onEvent` callback, and this sink is the callback the
 * controller composes. An event is appended to its run's events only when the ledger knows the run; anything else is
 * handed to `onUnrecorded` (a log line), never thrown, because `onEvent` must not throw.
 */
import type { Ledger } from "../ledger/index.js";
import type { EnvironmentEvent } from "./types.js";

export const ENVIRONMENT_EVENT_TYPE = "environment";
/** Runtime error text in `detail` is truncated to this many characters. */
export const ENVIRONMENT_DETAIL_MAX = 500;

export function environmentEventSink(
  ledger: Pick<Ledger, "getRunRecord" | "appendRunEvent">,
  onUnrecorded?: (event: EnvironmentEvent, why: string) => void,
): (event: EnvironmentEvent) => void {
  return (event) => {
    try {
      const runId = event.payload.run_id;
      if (ledger.getRunRecord(runId) === undefined) {
        onUnrecorded?.(event, "the ledger has no run with this id");
        return;
      }
      const { detail } = event.payload;
      const payload =
        typeof detail === "string" && detail.length > ENVIRONMENT_DETAIL_MAX
          ? { ...event.payload, detail: detail.slice(0, ENVIRONMENT_DETAIL_MAX) }
          : event.payload;
      ledger.appendRunEvent({ runId, type: ENVIRONMENT_EVENT_TYPE, payload });
    } catch (err) {
      onUnrecorded?.(event, err instanceof Error ? err.message : String(err));
    }
  };
}
