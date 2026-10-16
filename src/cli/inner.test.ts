/**
 * T11.7 (FR-INN-17, LLD §13.5, §13.8): the `doctor` inner-agent section, `inner status`, `inner test <task>` and
 * `inner resume <task>`. The backend is the scripted in-process fake (`CliIo.innerBackend`) or a fake HTTP server bound to
 * 127.0.0.1; no provider CLI, no real network host, no credential.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import { INNER_FIXTURES } from "../inner/fixture.js";
import { createFakeBackend, type FakeBackend, INNER_TASKS, type InnerTask } from "../inner/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { HELP, main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sb-inner-cli-"));
  mkdirSync(path.join(tmp, "repos"));
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeConfig(undefined);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeConfig(inner: Record<string, unknown> | undefined) {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(tmp, "repos")],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      ...(inner !== undefined ? { inner_agent: inner } : {}),
    }),
  );
}

const allTasks = () => Object.fromEntries(INNER_TASKS.map((t) => [t, { enabled: true }]));
const innerSection = (
  over: { backend?: Record<string, unknown>; tasks?: Record<string, unknown>; extra?: object } = {},
) => ({
  enabled: true,
  backend: { kind: "http", base_url: "http://127.0.0.1:1/v1", model: "test-model", ...over.backend },
  tasks: over.tasks ?? { commit_message: { enabled: true } },
  ...over.extra,
});

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
    adapters: new AdapterRegistry().register(new FakeAdapter()),
    ...extra,
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

const GOOD: Record<InnerTask, string> = {
  commit_message: '{"subject":"Fix greeting typo","body":"Adjust the synthetic greeting."}',
  pr_draft: '{"title":"Fix greeting","body":"Fixes a typo."}',
  route_features: '{"context_volume":"small","autonomy":"low","reasoning_depth":"low","task_kind":"docs"}',
  handoff_condense: '{"fields":{"goal":"Fix a typo."}}',
  log_summary: '{"summary":"All synthetic checks passed."}',
  run_title: '{"title":"Fix greeting typo"}',
};

describe("no inner_agent section: everything is off and doctor is unchanged", () => {
  it("inner status reports off with every task disabled", async () => {
    const r = await run(["inner", "status", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.inner_agent.state).toBe("off");
    expect(j.inner_agent.enabled).toBe(false);
    expect(j.inner_agent.backend).toBeNull();
    expect(j.inner_agent.ledger).toBe("absent");
    expect(j.inner_agent.tasks.map((t: { task: string }) => t.task)).toEqual([...INNER_TASKS]);
    expect(j.inner_agent.tasks.every((t: { enabled: boolean; suspended: boolean }) => !t.enabled && !t.suspended)).toBe(
      true,
    );
    const text = (await run(["inner", "status"])).out;
    expect(text).toContain("Inner agent: off");
  });

  it("doctor adds no key and no text", async () => {
    const j = JSON.parse((await run(["doctor", "--json"])).out);
    // No `inner_agent` key; `capacity` is T6.3's section, present whatever the inner-agent configuration.
    expect(Object.keys(j).sort()).toEqual(["adapters", "capacity", "checks", "ok", "schema_version"]);
    const text = (await run(["doctor"])).out;
    expect(text).not.toMatch(/Inner agent/i);
  });

  it("inner test sends nothing and creates no ledger; inner resume has nothing to do", async () => {
    const backend = createFakeBackend();
    const t = await run(["inner", "test", "commit_message", "--json"], { innerBackend: backend });
    expect(t.code).toBe(1);
    expect(JSON.parse(t.out)).toMatchObject({ ran: false, accepted: false, outcome: "off", call: null });
    expect(backend.requests).toHaveLength(0);
    expect(existsSync(dataDir)).toBe(false);
    const r = await run(["inner", "resume", "commit_message", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ resumed: false, reason: "NO_LEDGER" });
    expect(existsSync(dataDir)).toBe(false);
  });

  it("disabled section reports off too, and doctor shows the section as skipped", async () => {
    writeConfig({ enabled: false });
    expect(JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent.state).toBe("off");
    const j = JSON.parse((await run(["doctor", "--json"])).out);
    expect(j.inner_agent.state).toBe("off");
    expect(j.inner_agent.checks[0]).toMatchObject({ id: "inner_backend", status: "skip" });
    expect(j.ok).toBe(true);
  });
});

describe("doctor inner-agent section", () => {
  it("local backend: probes, reports locality, model, enabled tasks; origin only", async () => {
    writeConfig(innerSection({ tasks: { commit_message: { enabled: true }, run_title: { enabled: true } } }));
    const backend = createFakeBackend({ locality: "local" });
    const probe = vi.spyOn(backend, "probe");
    const r = await run(["doctor", "--json"], { innerBackend: backend });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    const s = j.inner_agent;
    expect(s.state).toBe("ready");
    expect(s.backend).toMatchObject({
      kind: "http",
      endpoint: "http://127.0.0.1:1",
      model: "test-model",
      locality: "local",
    });
    expect(s.resolved_locality).toBe("local");
    expect(s.probe).toMatchObject({ attempted: true, reachable: true, canary_ok: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(s.checks.map((c: { id: string }) => c.id)).toEqual([
      "inner_backend",
      "inner_breaker",
      "inner_tasks",
      "inner_task_commit_message",
      "inner_task_run_title",
    ]);
    expect(JSON.stringify(j)).not.toContain("/v1"); // the path is not printed, only scheme, host and port
    const text = (await run(["doctor"], { innerBackend: createFakeBackend() })).out;
    expect(text).toContain("Inner agent:");
    expect(text).toMatch(/\[ok\] {3}Inner agent: http http:\/\/127\.0\.0\.1:1, model test-model, local/);
    expect(text).toContain("enabled: commit_message, run_title");
  });

  it("a remote backend without allow_remote is never contacted; with it the canary runs", async () => {
    writeConfig(innerSection());
    const backend = createFakeBackend({ locality: "remote" });
    const probe = vi.spyOn(backend, "probe");
    const j = JSON.parse((await run(["doctor", "--json"], { innerBackend: backend })).out);
    expect(probe).not.toHaveBeenCalled();
    expect(backend.requests).toHaveLength(0);
    expect(j.inner_agent.probe).toMatchObject({ attempted: false, skipped_reason: "REMOTE_NOT_ALLOWED" });
    expect(j.inner_agent.resolved_locality).toBe("remote");
    expect(j.inner_agent.checks[0].status).toBe("warn");
    expect(j.inner_agent.checks[0].detail).toContain("REMOTE_NOT_ALLOWED");
    expect(j.ok).toBe(true); // a warning never fails doctor

    writeConfig(innerSection({ backend: { allow_remote: true } }));
    const allowed = createFakeBackend({ locality: "remote" });
    const probe2 = vi.spyOn(allowed, "probe");
    const j2 = JSON.parse((await run(["doctor", "--json"], { innerBackend: allowed })).out);
    expect(probe2).toHaveBeenCalledTimes(1);
    expect(j2.inner_agent.probe.attempted).toBe(true);
  });

  it("an unreachable backend and a hostile probe detail are warnings with a code only", async () => {
    writeConfig(innerSection());
    const backend = createFakeBackend({
      probe: {
        reachable: false,
        canary_ok: false,
        detail: "Authorization: Bearer sk-hostile-1234567890 echoed prompt",
      },
    });
    const r = await run(["doctor"], { innerBackend: backend });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[warn\] Inner agent: .*not reachable.*tasks use their fallback/);
    expect(r.out).not.toContain("sk-hostile");
    expect(r.out).not.toContain("Bearer");
  });

  it("works against a real fake HTTP server on 127.0.0.1 (canary), and against a closed port without failing", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "srv-model", choices: [{ message: { content: '{"ok":true}' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      writeConfig(innerSection({ backend: { base_url: `http://127.0.0.1:${port}` } }));
      const j = JSON.parse((await run(["doctor", "--json"])).out);
      expect(hits).toBe(1);
      expect(j.inner_agent.resolved_locality).toBe("local");
      expect(j.inner_agent.probe).toMatchObject({ attempted: true, reachable: true, canary_ok: true, detail: "OK" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const closed = await run(["doctor", "--json"]);
    expect(closed.code).toBe(0);
    expect(JSON.parse(closed.out).inner_agent.probe).toMatchObject({ attempted: true, reachable: false });
  });

  it("a cli backend is reported Ineligible and nothing is started", async () => {
    writeConfig({
      enabled: true,
      backend: { kind: "cli", provider: "opencode", model: "m" },
      tasks: { run_title: { enabled: true } },
    });
    const j = JSON.parse((await run(["doctor", "--json"])).out);
    expect(j.inner_agent.backend).toMatchObject({ kind: "cli", locality: "remote", eligible: false });
    expect(j.inner_agent.probe).toMatchObject({ attempted: false, skipped_reason: "INELIGIBLE" });
    expect(j.inner_agent.checks[0].detail).toContain("Ineligible");
  });

  it("keeps the shared-subscription warning in the existing checks list and does not duplicate it", async () => {
    writeConfig(innerSection({ backend: { shares_subscription_with: "claude-code" } }));
    const j = JSON.parse((await run(["doctor", "--json"], { innerBackend: createFakeBackend() })).out);
    expect(j.checks.filter((c: { id: string }) => c.id === "inner_shared_subscription")).toHaveLength(1);
    expect(JSON.stringify(j.inner_agent.checks)).not.toContain("shares the");
  });
});

describe("inner test", () => {
  it("sends only the built-in fixture: the captured prompt holds no repository, config, home or environment data", async () => {
    writeConfig(innerSection({ tasks: allTasks() }));
    const planted = "SWITCHBOARD_PLANTED_ENV_VALUE_8f3a";
    for (const task of INNER_TASKS) {
      const backend = createFakeBackend({ script: [{ kind: "text", text: GOOD[task] }] });
      const r = await run(["inner", "test", task, "--json"], { innerBackend: backend, env: { PLANTED: planted } });
      expect(r.code, `${task}: ${r.out}`).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({
        task,
        ran: true,
        accepted: true,
        outcome: "accepted",
        fixture: "built-in synthetic",
      });
      expect(backend.requests).toHaveLength(1);
      const req = backend.requests[0];
      expect(req?.task).toBe(task);
      expect(req?.user).toBe(INNER_FIXTURES[task].user);
      expect(req?.system).toBe(INNER_FIXTURES[task].contract.system);
      const sent = `${req?.system}\n${req?.user}`;
      for (const secret of [tmp, dataDir, configPath, process.cwd(), os.homedir(), planted, "mcp_clients", "c1"]) {
        expect(sent, `${task} must not contain ${secret}`).not.toContain(secret);
      }
    }
  });

  it("sends no content of a real repository under allowed_roots, on the first request or the re-ask", async () => {
    // The test above plants paths and an environment value; this one plants repository *content*: a committed file, a
    // staged diff, a commit message and a branch name, each with a marker the captured prompt must not contain.
    writeConfig(innerSection({ tasks: allTasks() }));
    const repo = path.join(tmp, "repos", "proj");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    const markers = [
      "REPO_FILE_MARKER_c41d",
      "REPO_STAGED_MARKER_9e07",
      "REPO_COMMIT_MARKER_5b2a",
      "repo-branch-marker-73f1",
    ];
    git("init", "-q", "-b", markers[3] as string);
    writeFileSync(path.join(repo, "a.txt"), `${markers[0]}\n`);
    git("add", "a.txt");
    git("commit", "-q", "-m", markers[2] as string);
    writeFileSync(path.join(repo, "a.txt"), `${markers[1]}\n`);
    git("add", "a.txt");

    for (const task of INNER_TASKS) {
      // First reply is off schema, so the pipeline re-asks: both captured requests must carry the fixture only.
      const backend = createFakeBackend({
        script: [
          { kind: "text", text: "not json" },
          { kind: "text", text: GOOD[task] },
        ],
      });
      const r = await run(["inner", "test", task, "--json"], {
        innerBackend: backend,
      });
      expect(r.code, `${task}: ${r.out}`).toBe(0);
      expect(backend.requests).toHaveLength(2);
      for (const req of backend.requests) {
        expect(req.user.startsWith(INNER_FIXTURES[task].user)).toBe(true);
        expect(req.system).toBe(INNER_FIXTURES[task].contract.system);
        const sent = JSON.stringify(req);
        for (const m of [...markers, repo]) expect(sent, `${task} must not contain ${m}`).not.toContain(m);
      }
      for (const m of markers) expect(r.out).not.toContain(m);
    }
  });

  it("records one inner_call row with no run, and prints no prompt or response body", async () => {
    writeConfig(innerSection());
    const body = "RESPONSE_BODY_MARKER_77";
    const backend = createFakeBackend({
      script: [{ kind: "text", text: `{"subject":"${body}"}`, model_id: "model\u0007\nwith-control" }],
    });
    const r = await run(["inner", "test", "commit_message", "--json"], { innerBackend: backend });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(body);
    expect(r.out).not.toContain("synthetic world"); // the fixture text itself
    const call = JSON.parse(r.out).call;
    expect(call).toMatchObject({ locality: "local", attempts: 1 });
    expect(call.model_id).toBe("modelwith-control");
    const text = (
      await run(["inner", "test", "commit_message"], {
        innerBackend: createFakeBackend({ script: [{ kind: "text", text: `{"subject":"${body}"}` }] }),
      })
    ).out;
    expect(text).not.toContain(body);
    expect(text).toContain("no repository data is sent");

    const db = openLedger(dataDir);
    try {
      const rows = createLedger(db).listInnerCalls();
      expect(rows).toHaveLength(2);
      expect(rows.every((x) => x.run_id === null && x.outcome === "accepted")).toBe(true);
    } finally {
      db.close();
    }
    const st = JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent;
    expect(st.ledger).toBe("present");
    expect(st.tasks.find((t: { task: string }) => t.task === "commit_message").calls.accepted).toBe(2);
  });

  it("a rejected result exits 1 with the outcome; a remote backend without allow_remote is refused with no request", async () => {
    writeConfig(innerSection());
    const bad = createFakeBackend({ script: [{ kind: "text", text: "not json" }] });
    const r = await run(["inner", "test", "commit_message", "--json"], { innerBackend: bad });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ accepted: false, outcome: "rejected_validator" });

    const remote = createFakeBackend({ locality: "remote" });
    const d = await run(["inner", "test", "commit_message", "--json"], { innerBackend: remote });
    expect(d.code).toBe(1);
    expect(JSON.parse(d.out)).toMatchObject({
      accepted: false,
      outcome: "fallback_disabled",
      reason: "REMOTE_NOT_ALLOWED",
    });
    expect(remote.requests).toHaveLength(0);

    writeConfig(innerSection({ backend: { allow_remote: true } }));
    const ok = createFakeBackend({ locality: "remote", script: [{ kind: "text", text: GOOD.commit_message }] });
    expect((await run(["inner", "test", "commit_message"], { innerBackend: ok })).code).toBe(0);
    expect(ok.requests).toHaveLength(1); // the fixture sends no source content, so allow_source_content is not needed
  });

  it("a task that is not enabled sends nothing", async () => {
    writeConfig(innerSection());
    const backend = createFakeBackend();
    const r = await run(["inner", "test", "run_title", "--json"], { innerBackend: backend });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ran: false, outcome: "task_not_enabled" });
    expect(backend.requests).toHaveLength(0);
  });
});

describe("inner status and inner resume", () => {
  function seedRejections(task: InnerTask, n: number) {
    const db = openLedger(dataDir);
    try {
      const ledger = createLedger(db);
      for (let i = 0; i < n; i++) {
        ledger.recordInnerCall(
          {
            task,
            backend_kind: "http",
            model_id: "m",
            locality: "local",
            template_version: `${task}.v1`,
            outcome: "rejected_validator",
            reason: null,
            attempts: 2,
            latency_ms: 5,
            tokens_in: null,
            tokens_out: null,
            input_bytes: 10,
            output_bytes: 4,
            input_sha256: "0".repeat(64),
            run_id: null,
            meta_session_id: null,
          },
          { suspension: { windowCalls: 50, minCalls: 20, rejectionThreshold: 0.4 } },
        );
      }
      expect(ledger.getInnerTaskState(task)?.suspended).toBe(true);
    } finally {
      db.close();
    }
  }

  it("shows counts, rates and the suspended state in status and doctor; resume re-enables once", async () => {
    writeConfig(innerSection({ tasks: { commit_message: { enabled: true }, run_title: { enabled: true } } }));
    seedRejections("commit_message", 20);

    const st = JSON.parse(
      (await run(["inner", "status", "--json"], { innerBackend: createFakeBackend() })).out,
    ).inner_agent;
    const cm = st.tasks.find((t: { task: string }) => t.task === "commit_message");
    expect(cm).toMatchObject({ enabled: true, suspended: true, total_calls: 20 });
    expect(cm.calls.rejected_validator).toBe(20);
    expect(cm.window).toMatchObject({ calls: 20, rejected: 20, rejection_rate: 1, threshold: 0.4 });
    expect(cm.suspended_basis).toMatchObject({ rejected: 20, total: 20 });
    expect(st.tasks.find((t: { task: string }) => t.task === "run_title")).toMatchObject({
      suspended: false,
      total_calls: 0,
      fallback_rate: null,
    });
    const text = (await run(["inner", "status"], { innerBackend: createFakeBackend() })).out;
    expect(text).toContain("SUSPENDED");
    expect(text).toContain("switchboard inner resume commit_message");

    const doc = JSON.parse((await run(["doctor", "--json"], { innerBackend: createFakeBackend() })).out);
    const check = doc.inner_agent.checks.find((c: { id: string }) => c.id === "inner_task_commit_message");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("SUSPENDED");
    expect(doc.ok).toBe(true);

    const resumed = await run(["inner", "resume", "commit_message", "--json"]);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.out)).toMatchObject({ task: "commit_message", resumed: true, version: 2 });
    const after = JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent.tasks.find(
      (t: { task: string }) => t.task === "commit_message",
    );
    expect(after.suspended).toBe(false);
    expect(after.window.calls).toBe(0); // counting restarts after the resume
    expect(after.total_calls).toBe(20); // history stays
    const again = JSON.parse((await run(["inner", "resume", "commit_message", "--json"])).out);
    expect(again).toMatchObject({ resumed: false, reason: "NOT_SUSPENDED" });
  });

  it("a suspended task falls back in inner test until resumed", async () => {
    writeConfig(innerSection());
    seedRejections("commit_message", 20);
    const backend = createFakeBackend({ script: [{ kind: "text", text: GOOD.commit_message }] });
    const r = await run(["inner", "test", "commit_message", "--json"], { innerBackend: backend });
    expect(JSON.parse(r.out)).toMatchObject({
      accepted: false,
      outcome: "fallback_suspended",
      reason: "TASK_SUSPENDED",
    });
    expect(backend.requests).toHaveLength(0);
    await run(["inner", "resume", "commit_message"]);
    expect((await run(["inner", "test", "commit_message"], { innerBackend: backend })).code).toBe(0);
  });

  it("status never contacts the backend", async () => {
    writeConfig(innerSection());
    const backend: FakeBackend = createFakeBackend();
    const probe = vi.spyOn(backend, "probe");
    const resolve = vi.spyOn(backend, "resolveLocality");
    await run(["inner", "status"], { innerBackend: backend });
    expect(probe).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(backend.requests).toHaveLength(0);
  });

  it("status shows a base URL as an origin and a host name as unresolved", async () => {
    writeConfig(innerSection({ backend: { base_url: "https://gateway.example.test:8443/v1/secret-path" } }));
    const j = JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent.backend;
    expect(j).toMatchObject({ endpoint: "https://gateway.example.test:8443", locality: "unresolved" });
    writeConfig(innerSection({ backend: { base_url: "http://10.1.2.3:8080" } }));
    expect(JSON.parse((await run(["inner", "status", "--json"])).out).inner_agent.backend).toMatchObject({
      locality: "remote",
      address_class: "private",
    });
  });
});

describe("usage and help", () => {
  it("rejects bad invocations with exit 2", async () => {
    for (const args of [
      ["inner"],
      ["inner", "bogus"],
      ["inner", "test"],
      ["inner", "test", "nope"],
      ["inner", "resume"],
      ["inner", "status", "x"],
      ["inner", "test", "run_title", "extra"],
    ]) {
      expect((await run(args)).code, args.join(" ")).toBe(2);
    }
  });

  it("is listed in HELP without any sign-in wording", () => {
    expect(HELP).toContain("inner status");
    expect(HELP).toContain("inner test <task>");
    expect(HELP).toContain("inner resume <task>");
    expect(HELP).not.toMatch(/login|logout|auth/i);
  });
});
