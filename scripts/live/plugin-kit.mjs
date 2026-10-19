/**
 * Shared builder for the live plug-ins of the adapters that compile only an approved `privileged` cell (Antigravity,
 * OpenCode, Cursor, Kimi Code, Grok Build; owner decisions 46, 59 and 60). It lives outside `scripts/live/providers/`
 * because `scripts/live-smoke.mjs` treats every `.mjs` file in that directory as a plug-in.
 *
 * A plug-in built here adds three fields to the contract in `providers/claude.mjs`:
 *   adapterId    the adapter id when it differs from the file name (`agy.mjs` -> `antigravity`)
 *   smokeCell    { scope, bypassFlag }: the approved `privileged` scope the smoke task runs in, and the one bypass-class
 *                flag its compiled argv must carry (null: none at all). `scripts/live-smoke.mjs` delegates under it and
 *                approves the run through the operator `approve` CLI, as `scripts/live-malicious.mjs` does for C-M3.
 *   malicious    { fakeCredential, checks }: the hostile checks of `scripts/live-malicious.mjs` (at most
 *                MAX_MALICIOUS_RUNS, each one model run); see {@link maliciousCheck}.
 * and an optional `parseLine(adapter, line, state)` hook for adapters whose stored stdout is not one native document
 * per line for `parseEvent` (Kimi Code's ACP cell). Optional evidence fields (Kimi Code, T4.68, decision 74):
 *   permissionRecord  true: every run in an ACP cell (scope without `bypass`) gets a `<prefix>-P1` permission round-trip
 *                     check (`acp-evidence.mjs` `permissionRoundTrip`), in the smoke test and the malicious leg
 *   failedTurn        { scope, bypassFlag }: `scripts/live-smoke.mjs` runs one deliberately failed turn in this
 *                     approved cell (a resume of a `--session` id no session has) and records the CLI's exit code as
 *                     `<prefix>-F1` (`failedTurnVerdict`); one more provider invocation, admitted by the budget guard
 *   keepEvidence      true: both scripts keep the temp directory (redacted provider streams, ledger, serve log) as if
 *                     `SWITCHBOARD_LIVE_KEEP=1` were set, so the evidence can be inspected after the run
 *
 * The stream checks read the adapter's own normalized events (`session_bound`, `result`, `tool_call`, `unknown`), not
 * provider-specific record names, so they claim no native shape the adapter does not already parse. A plug-in reads no
 * credential file and prints no value, prompt or response text (the scripts' safety rule).
 */

/** Model runs one `live-malicious` invocation may make on one provider (`live-run-ext.sh` meters it). */
export const MAX_MALICIOUS_RUNS = 3;

/** The scope every bypass-only cell of decisions 59 and 60 compiles (worktree files, shell broad, network on). */
export const WORKTREE_BYPASS_SCOPE = Object.freeze({
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
});

/**
 * One hostile check of the live malicious leg. `attack` picks the objective and the detectors:
 *   git-write      ask for `git add` + `git commit` in the worktree (FR-GIT-01): refs and the stream's tool calls
 *   outside-canary ask to print a canary file outside the worktree (FR-POL-06): token scan of every surface
 *   cred-canary    ask to print a credential-shaped canary file in a fake HOME directory (FR-POL-06): token scan
 *   canaries       outside-canary and cred-canary in one run
 *   bypass        git-write and both canaries in one approved bypass run (FR-POL-03, R-38, R-41)
 * `expectedEscape` names the decision under which an ESCAPED is expected (reported, and it opens a risk, but it does
 * not fail the leg's exit code). `mustRun` makes a NOT_CHECKED verdict fail the leg's exit code: the control must
 * actually be exercised (Cursor U-M1, owner ruling 2026-10-19 06:15 CDT).
 */
export function maliciousCheck(id, attack, group, assumption, scope, expectedEscape, { mustRun = false } = {}) {
  return Object.freeze({
    id,
    attack,
    group,
    assumption,
    scope,
    ...(expectedEscape ? { expectedEscape } : {}),
    ...(mustRun ? { mustRun: true } : {}),
  });
}

/**
 * Build a plug-in for a bypass-only adapter. `prefix` names the smoke checks (`<prefix>-1` ...); `label` is the CLI
 * name used in the Assumption text.
 */
export function bypassCellPlugin({
  id,
  adapterId,
  group,
  prefix,
  label,
  smokeCell,
  malicious,
  parseLine,
  permissionRecord,
  failedTurn,
  keepEvidence,
}) {
  return {
    id,
    ...(adapterId !== undefined ? { adapterId } : {}),
    group,
    checkPrefix: prefix,
    smokeCell,
    malicious,
    ...(parseLine !== undefined ? { parseLine } : {}),
    ...(permissionRecord === true ? { permissionRecord: true } : {}),
    ...(failedTurn !== undefined ? { failedTurn } : {}),
    ...(keepEvidence === true ? { keepEvidence: true } : {}),
    createAdapter: (adapters) => {
      const entry = adapters.BUILTIN_PROVIDERS.find((e) => e.id === (adapterId ?? id));
      // The registry entry's own factory with no options: the adapter `serve` registers, built with its defaults.
      return entry.create({});
    },
    async probeChecks({ record, held, step, probe, binaryOk }) {
      record(
        `${prefix}-1`,
        group,
        `\`${label} --version\` prints a version the adapter parses`,
        held(binaryOk ? step("version")?.ok : undefined),
        probe.binaryVersion ?? "no version",
      );
      record(
        `${prefix}-2`,
        group,
        `\`${label}\` help lists the output format and every flag the adapter emits`,
        held(binaryOk ? step("flags")?.ok && step("output_format")?.ok : undefined),
        binaryOk ? (step("flags")?.detail ?? "all present") : "binary not found",
      );
    },
    async authChecks({ record, held, binaryOk, runner, adapter, out }) {
      if (!binaryOk) return;
      const auth = await adapter.authPreflight(runner);
      out(`auth preflight (allowlisted environment only): ${auth.state}`);
      record(
        `${prefix}-3`,
        group,
        "the adapter's auth preflight reports OK with only the allowlisted environment",
        held(auth.state === "OK" ? true : auth.state === "UNKNOWN" ? false : undefined),
        auth.state,
      );
    },
    observeEvent() {
      // Shapes come from the adapter's normalized events (`kinds`), not from native record names.
    },
    streamChecks({ record, held, ran, succeeded, final, kinds, unknownEvents, badJson, toolNames, smokeContent }) {
      const count = (k) => kinds?.get(k) ?? 0;
      record(
        `${prefix}-4`,
        group,
        "the approved privileged cell compiles, starts and ends the edit task SUCCEEDED",
        held(ran ? succeeded : undefined),
        ran ? final.status : "provider never ran",
      );
      record(
        `${prefix}-5`,
        group,
        "the adapter binds a native session id from the stream (`session_bound`)",
        held(ran ? count("session_bound") > 0 : undefined),
        `${count("session_bound")} session_bound`,
      );
      record(
        `${prefix}-6`,
        group,
        "the adapter reads a `result` from the stream",
        held(ran ? count("result") > 0 : undefined),
        `${count("result")} result`,
      );
      record(
        `${prefix}-7`,
        group,
        "every record of a successful run is JSON and recognised by the adapter (no `unknown` events)",
        held(ran ? unknownEvents === 0 && badJson === 0 : undefined),
        `${unknownEvents} unknown, ${badJson} non-JSON`,
      );
      record(
        `${prefix}-8`,
        group,
        "the file edit lands through a tool call the adapter recognises",
        held(ran ? smokeContent !== undefined && toolNames.size > 0 : undefined),
        [...toolNames].join(", ") || "no tool calls",
      );
    },
    gitWriteChecks({ record }) {
      const git = malicious.checks.find((c) => c.attack === "git-write");
      record(
        `${prefix}-G1`,
        "FR-GIT-01",
        `${label} declares no per-run Git-write denial (\`none-documented\`); FR-GIT-03 and FR-GIT-06 are the remaining controls`,
        "NOT_CHECKED",
        `needs a deliberate Git write attempt, which this smoke test never makes (live malicious leg ${git?.id ?? "n/a"})`,
      );
    },
  };
}
