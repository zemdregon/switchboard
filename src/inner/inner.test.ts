import { describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import {
  createFakeBackend,
  createInnerAgent,
  INNER_TASKS,
  type InnerAgentSettings,
  type InnerRequest,
} from "./index.js";

const req = (user = "hello"): InnerRequest => ({
  task: "run_title",
  template_version: "run_title.v1",
  system: "fixed",
  user,
  max_output_tokens: 20,
  response_schema: { type: "object" },
});

const settings = (over: Parameters<typeof resolveInnerAgent>[0]): InnerAgentSettings => resolveInnerAgent(over);
const backendCfg = { kind: "http", base_url: "http://127.0.0.1:1", model: "m" } as const;

describe("inner-agent service shell (T11.1; FR-INN-01, FR-INN-05)", () => {
  it("no settings: off, every task disabled, no backend", () => {
    const svc = createInnerAgent(undefined);
    expect(svc.state).toBe("off");
    expect(svc.backend).toBeUndefined();
    for (const t of INNER_TASKS) expect(svc.taskEnabled(t)).toBe(false);
  });

  it("a backend handed to a disabled agent is ignored", () => {
    const svc = createInnerAgent(
      settings({ enabled: false, backend: backendCfg, tasks: { run_title: { enabled: true } } }),
      {
        backend: createFakeBackend(),
      },
    );
    expect(svc.state).toBe("off");
    expect(svc.backend).toBeUndefined();
    expect(svc.taskEnabled("run_title")).toBe(false);
  });

  it("enabled without a backend object is no_backend and enables no task", () => {
    const svc = createInnerAgent(
      settings({ enabled: true, backend: backendCfg, tasks: { run_title: { enabled: true } } }),
    );
    expect(svc.state).toBe("no_backend");
    expect(svc.taskEnabled("run_title")).toBe(false);
  });

  it("ready: only the tasks the operator switched on are enabled (none by default)", () => {
    const backend = createFakeBackend();
    const on = createInnerAgent(
      settings({ enabled: true, backend: backendCfg, tasks: { run_title: { enabled: true } } }),
      {
        backend,
      },
    );
    expect(on.state).toBe("ready");
    expect(INNER_TASKS.filter((t) => on.taskEnabled(t))).toEqual(["run_title"]);
    const none = createInnerAgent(settings({ enabled: true, backend: backendCfg }), { backend });
    expect(INNER_TASKS.filter((t) => none.taskEnabled(t))).toEqual([]);
  });
});

describe("scripted fake backend (TDD §3.12)", () => {
  const sig = () => new AbortController().signal;

  it("plays the script in order, repeats the last step and records exact requests", async () => {
    const b = createFakeBackend({
      script: [
        { kind: "text", text: "one", usage: { in: 3, out: null } },
        { kind: "empty" },
        { kind: "error", message: "boom" },
        { kind: "text", text: "last" },
      ],
      model_id: "fm",
    });
    expect(await b.complete(req("a"), sig())).toEqual({ text: "one", usage: { in: 3, out: null }, model_id: "fm" });
    expect(await b.complete(req("b"), sig())).toEqual({ text: "", model_id: "fm" });
    await expect(b.complete(req("c"), sig())).rejects.toThrow("boom");
    expect((await b.complete(req("d"), sig())).text).toBe("last");
    expect((await b.complete(req("e"), sig())).text).toBe("last");
    expect(b.requests.map((r) => r.user)).toEqual(["a", "b", "c", "d", "e"]);
    b.setScript([{ kind: "text", text: "again" }]);
    expect((await b.complete(req(), sig())).text).toBe("again");
  });

  it("delay and hang honour the abort signal", async () => {
    const b = createFakeBackend({ script: [{ kind: "text", text: "slow", delay_ms: 5000 }, { kind: "hang" }] });
    const c1 = new AbortController();
    const p1 = b.complete(req(), c1.signal);
    c1.abort(new Error("deadline"));
    await expect(p1).rejects.toThrow("deadline");
    const c2 = new AbortController();
    const p2 = b.complete(req(), c2.signal);
    setTimeout(() => c2.abort(new Error("deadline 2")), 10);
    await expect(p2).rejects.toThrow("deadline 2");
    const done = new AbortController();
    done.abort();
    await expect(b.complete(req(), done.signal)).rejects.toThrow();
  });

  it("reports kind, locality (settable) and probe results", async () => {
    const b = createFakeBackend({ kind: "cli", locality: "remote", probe: { eligible: false, detail: "Ineligible" } });
    expect(b.kind).toBe("cli");
    expect(await b.resolveLocality(sig())).toBe("remote");
    b.locality = "local";
    expect(await b.resolveLocality(sig())).toBe("local");
    expect(await b.probe(sig())).toEqual({ reachable: true, canary_ok: true, eligible: false, detail: "Ineligible" });
  });
});
