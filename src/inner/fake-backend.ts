/**
 * Scripted fake inner backend (T11.1; TDD §3.12). In-process: no network, no provider CLI, no model. T11.3 adds the
 * loopback HTTP server variant for the `http` kind; this one implements the port directly so the pipeline (T11.2) and the
 * task tests can be driven deterministically.
 *
 * Each `complete` call consumes the next scripted step (the last step repeats once the script is exhausted) and records
 * the exact request it received. A step is one of: a completion `text`; an `error` (rejects); an `empty` completion;
 * `delay_ms` before answering; `hang` (never answers until the signal aborts). The abort signal is always honoured.
 */
import type { InnerBackend, InnerProbeResult, InnerRequest, InnerResult, Locality } from "./port.js";

export type FakeStep =
  | { kind: "text"; text: string; usage?: InnerResult["usage"]; model_id?: string; delay_ms?: number }
  | { kind: "empty"; delay_ms?: number }
  | { kind: "error"; message?: string; delay_ms?: number }
  | { kind: "hang" };

export interface FakeBackendOptions {
  kind?: "http" | "cli";
  locality?: Locality;
  /** Steps consumed in order; the last repeats. Default: one `{"ok":true}` text step. */
  script?: readonly FakeStep[];
  model_id?: string;
  probe?: Partial<InnerProbeResult>;
}

export interface FakeBackend extends InnerBackend {
  /** Every request received, in order (a copy, so a test can assert on the exact prompt). */
  readonly requests: readonly InnerRequest[];
  locality: Locality;
  /** Replace the script and restart from its first step. */
  setScript(script: readonly FakeStep[]): void;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

export function createFakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  let script: readonly FakeStep[] = options.script ?? [{ kind: "text", text: '{"ok":true}' }];
  let index = 0;
  const requests: InnerRequest[] = [];
  const modelId = options.model_id ?? "fake-model";
  const backend: FakeBackend = {
    kind: options.kind ?? "http",
    locality: options.locality ?? "local",
    requests,
    setScript(next) {
      script = next;
      index = 0;
    },
    async resolveLocality(signal) {
      if (signal.aborted) throw abortError(signal);
      return backend.locality;
    },
    async complete(req, signal) {
      if (signal.aborted) throw abortError(signal);
      requests.push(structuredClone(req));
      const step = script[Math.min(index, script.length - 1)] ?? { kind: "empty" };
      index++;
      if (step.kind === "hang") {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
        });
      }
      if ("delay_ms" in step && step.delay_ms !== undefined) await wait(step.delay_ms, signal);
      if (step.kind === "error") throw new Error(step.message ?? "fake backend error");
      if (step.kind === "empty") return { text: "", model_id: modelId };
      if (step.kind === "text") {
        return {
          text: step.text,
          ...(step.usage !== undefined ? { usage: step.usage } : {}),
          model_id: step.model_id ?? modelId,
        };
      }
      throw new Error("unreachable");
    },
    async probe() {
      return { reachable: true, canary_ok: true, eligible: true, detail: "fake", ...options.probe };
    },
  };
  return backend;
}
