/**
 * Live-smoke plug-in for Codex (T4.3). One file per provider in this directory is the whole plug-in point of
 * `scripts/live-smoke.mjs`: the script lists `scripts/live/providers/*.mjs`, picks the file named by
 * SWITCHBOARD_LIVE_PROVIDER and calls the hooks below. The shared flow (skip unless SWITCHBOARD_LIVE_TESTS=1, probe,
 * one edit task through `switchboard serve`, ledger evidence, Git ref check, report) stays in the script. A plug-in
 * must read no credential file and print no value, prompt or response text (the script's safety rule).
 *
 * Contract (every hook receives one context object):
 *   id, group, checkPrefix   provider id (also the adapter id), assumption group for the report, check id prefix
 *   createAdapter(adapters)  the real adapter, built from the compiled `dist/adapters/index.js` module
 *   probeChecks(ctx)         record() the probe-level Assumptions (ctx: record, held, step, probe, binaryOk, runner, group)
 *   authChecks(ctx)          record() the auth-status Assumptions (ctx adds adapter, out)
 *   observeEvent(doc, shapes) note the shape of one native stream document (types only, no content)
 *   streamChecks(ctx)        record() the stream Assumptions after the run (ctx: record, held, ran, succeeded, final,
 *                            shapes, unknownEvents, badJson, toolNames, smokeContent, group)
 *   gitWriteChecks(ctx)      record() the FR-GIT-01 Assumption this smoke test does not provoke (ctx: record)
 */

const GROUP_ID = "R-22";

export default {
  id: "codex",
  group: GROUP_ID,
  checkPrefix: "X",
  createAdapter: (adapters) => new adapters.CodexAdapter(),
  async probeChecks({ record, held, step, probe, binaryOk, runner, group }) {
    const GROUP = group;
    record(
      "X-1",
      GROUP,
      "`codex --version` prints a parseable version line",
      held(binaryOk ? step("version")?.ok : undefined),
      probe.binaryVersion ?? "no version",
    );
    record(
      "X-2",
      GROUP,
      "`codex exec --help` lists --json, --sandbox and the ignore-config/rules flags",
      held(binaryOk ? step("flags")?.ok && step("output_format")?.ok : undefined),
      binaryOk ? (step("flags")?.detail ?? "all present") : "binary not found",
    );
    if (binaryOk) {
      const help = await runner([probe.binaryPath, "exec", "--help"]);
      const text = help.exitCode === 0 ? help.stdout : "";
      record(
        "X-3",
        GROUP,
        "the sandbox values are spelled `read-only` and `workspace-write`",
        held(text ? text.includes("read-only") && text.includes("workspace-write") : undefined),
        text ? "searched `codex exec --help`" : "help unavailable",
      );
    } else {
      record(
        "X-3",
        GROUP,
        "the sandbox values are spelled `read-only` and `workspace-write`",
        "NOT_CHECKED",
        "binary not found",
      );
    }
  },
  async authChecks({ record, out }) {
    out(
      "auth status: Codex documents no status command (Q-10); the adapter reports UNKNOWN, so routing is expected to refuse it",
    );
    record(
      "X-4",
      "Q-10",
      "a Codex auth status mechanism exists that the adapter can use",
      "NOT_CHECKED",
      "no documented command; adapter returns UNKNOWN (fail closed)",
    );
  },
  observeEvent(doc, shapes) {
    if (doc?.type === "thread.started") shapes.threadStarted = typeof doc.thread_id === "string";
    if (doc?.type === "turn.completed") shapes.turnCompleted = typeof doc.usage === "object" && doc.usage !== null;
  },
  streamChecks({ record, held, ran, succeeded, final, shapes, unknownEvents, badJson, group }) {
    const GROUP = group;
    record(
      "X-5",
      GROUP,
      "`codex exec --json` reads the prompt from stdin",
      held(ran ? succeeded : undefined),
      ran ? final.status : "provider never ran",
    );
    record(
      "X-6",
      GROUP,
      "the stream has `thread.started` with `thread_id`",
      held(ran ? shapes.threadStarted === true : undefined),
      String(shapes.threadStarted ?? "no such event"),
    );
    record(
      "X-7",
      GROUP,
      "`turn.completed` carries `usage`",
      held(ran ? shapes.turnCompleted === true : undefined),
      String(shapes.turnCompleted ?? "no such event"),
    );
    record(
      "X-8",
      GROUP,
      "every event and item type in a successful run is recognised (no `unknown` events)",
      held(ran ? unknownEvents === 0 && badJson === 0 : undefined),
      `${unknownEvents} unknown, ${badJson} non-JSON`,
    );
    record(
      "X-9",
      GROUP,
      "error `code` strings and the `declined` item status",
      "NOT_CHECKED",
      "needs a failing run; not provoked by this smoke test",
    );
  },
  gitWriteChecks({ record }) {
    record(
      "X-G1",
      "FR-GIT-01",
      "the workspace-write sandbox blocks writes to the worktree's Git directory (outside the cwd, under .git/worktrees/)",
      "NOT_CHECKED",
      "needs a deliberate `git commit` attempt inside the sandbox, which this smoke test never makes (malicious fixtures: T9.5)",
    );
  },
};
