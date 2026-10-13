/**
 * Live-smoke plug-in for Claude Code (T4.3). One file per provider in this directory is the whole plug-in point of
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

const GROUP_ID = "R-21";

export default {
  id: "claude",
  group: GROUP_ID,
  checkPrefix: "C",
  createAdapter: (adapters) => new adapters.ClaudeAdapter(),
  async probeChecks({ record, held, step, probe, binaryOk, group }) {
    const GROUP = group;
    record(
      "C-1",
      GROUP,
      "`claude --version` prints `<semver> (Claude Code)`",
      held(binaryOk ? step("version")?.ok : undefined),
      probe.binaryVersion ?? "no version",
    );
    record(
      "C-2",
      GROUP,
      "`claude --help` lists every flag the adapter emits (--safe-mode, --restricted, --disallowedTools, ...)",
      held(binaryOk ? step("flags")?.ok && step("output_format")?.ok : undefined),
      binaryOk ? (step("flags")?.detail ?? "all present") : "binary not found",
    );
  },
  async authChecks({ record, held, probe, binaryOk, runner, adapter, out, group }) {
    const GROUP = group;
    if (!binaryOk) return;
    // Status command shape only: exit code, parse, key NAMES. Values are never printed.
    const r = await runner([probe.binaryPath, "auth", "status", "--json"]);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = undefined;
    }
    const isObj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    const keys = isObj ? Object.keys(parsed).sort() : [];
    out(`auth status: exit ${r.exitCode}, JSON ${isObj ? "object" : "not parseable"}, keys [${keys.join(", ")}]`);
    record("C-3", GROUP, "`claude auth status --json` prints a JSON object", held(isObj), `exit ${r.exitCode}`);
    record(
      "C-4",
      GROUP,
      "the status JSON has a boolean `loggedIn` field consistent with the exit code (0 = logged in)",
      held(
        isObj ? typeof parsed.loggedIn === "boolean" && (parsed.loggedIn === true) === (r.exitCode === 0) : undefined,
      ),
      isObj ? `loggedIn is ${typeof parsed.loggedIn}` : "no JSON",
    );
    const auth = await adapter.authPreflight(runner);
    out(
      `auth preflight (PATH and HOME only): ${auth.state}${auth.state === "AUTH_REQUIRED" ? ` -> run \`${auth.loginCommand}\` yourself` : ""}`,
    );
    record(
      "C-5",
      GROUP,
      "the status command works with only PATH and HOME in its environment",
      held(auth.state === "OK" ? true : auth.state === "UNKNOWN" ? false : undefined),
      auth.state,
    );
  },
  observeEvent(doc, shapes) {
    if (doc?.type === "system" && doc.subtype === "init") shapes.initWithSession = typeof doc.session_id === "string";
    if ((doc?.type === "assistant" || doc?.type === "user") && shapes.contentBlocks !== false) {
      shapes.contentBlocks = Array.isArray(doc.message?.content);
    }
    if (doc?.type === "result") {
      shapes.resultFields = ["subtype", "is_error", "session_id", "usage"].every((k) => k in doc);
    }
  },
  streamChecks({
    record,
    held,
    ran,
    succeeded,
    final,
    shapes,
    unknownEvents,
    badJson,
    toolNames,
    smokeContent,
    group,
  }) {
    const GROUP = group;
    record(
      "C-6",
      GROUP,
      "`-p` reads the prompt from stdin and `--verbose` is accepted with stream-json",
      held(ran ? succeeded : undefined),
      ran ? final.status : "provider never ran",
    );
    record(
      "C-7",
      GROUP,
      "stream starts with `system`/`init` carrying `session_id`",
      held(ran ? shapes.initWithSession === true : undefined),
      String(shapes.initWithSession ?? "no init event"),
    );
    record(
      "C-8",
      GROUP,
      "`assistant`/`user` events carry `message.content[]` blocks",
      held(ran ? shapes.contentBlocks === true : undefined),
      String(shapes.contentBlocks ?? "no such events"),
    );
    record(
      "C-9",
      GROUP,
      "the `result` event has `subtype`, `is_error`, `session_id` and `usage`",
      held(ran ? shapes.resultFields === true : undefined),
      String(shapes.resultFields ?? "no result event"),
    );
    record(
      "C-10",
      GROUP,
      "every event type in a successful run is recognised (no `unknown` events)",
      held(ran ? unknownEvents === 0 && badJson === 0 : undefined),
      `${unknownEvents} unknown, ${badJson} non-JSON`,
    );
    record(
      "C-11",
      GROUP,
      "the file-creating tool is named `Write` (or `Edit`) and is allowed by --tools",
      held(ran ? smokeContent !== undefined && (toolNames.has("Write") || toolNames.has("Edit")) : undefined),
      [...toolNames].join(", ") || "no tool calls",
    );
    record(
      "C-12",
      GROUP,
      "error category strings (rate_limit, overloaded, authentication_failed, ...)",
      "NOT_CHECKED",
      "needs a failing run; not provoked by this smoke test",
    );
  },
  gitWriteChecks({ record }) {
    record(
      "C-G2",
      "FR-GIT-01",
      "`--disallowedTools` Git deny rules (`Bash(git commit *)`, ...) are accepted with no Bash in --tools and deny a Git write",
      "NOT_CHECKED",
      "acceptance is covered by C-6 (the run starts); denial needs a deliberate Git write attempt, which this smoke test never makes (malicious fixtures: T9.5). " +
        'Depends on bypass: an approved privileged run with `bypass: true` adds --dangerously-skip-permissions (`claude --help`: "Bypass all permission checks") and keeps these deny rules; ' +
        "whether Claude still honours deny rules under that flag is an Assumption, unverified (R-26, TDD §4.1.1; live check T3.9), and this smoke test never runs a bypass invocation",
    );
  },
};
