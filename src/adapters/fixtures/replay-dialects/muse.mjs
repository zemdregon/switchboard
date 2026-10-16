// Muse Code dialect of the shared replay helper (T4.77, FR-ADP-11): `exec --json -w off --approval-mode on-request
// --sandbox-network restricted|unrestricted --trust-workspace [--session-id <uuid>] <prompt>` with the prompt as the
// last argv word and stdin unused (src/adapters/muse/adapter.ts). Muse fixtures carry literal SYNTHETIC uuids, so the
// session placeholder {{SESSION_ID}} is only substituted on resume. The version and help text below are SYNTHETIC test
// data (the format reported by a third party, TDD §4.8), not a claim about the real CLI; no `muse` was run.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const NETWORK_VALUES = ["restricted", "unrestricted"];

// Mirrors BYPASS_FLAGS in src/adapters/audit.ts plus Muse Code's declared bypass flags and the flags the adapter never
// emits (adapter.ts and the T4.72 argv invariants): the replay refuses to run if any appear (defence in depth).
const REFUSED = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
  "--disable-approval",
  "--disable-sandbox",
  "-c",
  "--config",
  "--provider",
  "--prompt-file",
  "--worktree",
  "--worktree-existing",
  "--subagent-worktree-isolation",
  "--allow-workspace-switch",
  "--no-session-log",
  "--approval-judge",
];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (argv[0] !== "exec" || !argv.includes("--json")) fail("expected muse exec --json", 64);
    if (opt(argv, "-w") !== "off") fail("expected -w off", 64);
    if (opt(argv, "--approval-mode") !== "on-request") fail("expected --approval-mode on-request", 64);
    if (!NETWORK_VALUES.includes(opt(argv, "--sandbox-network") ?? "")) {
      fail("expected --sandbox-network restricted|unrestricted", 64);
    }
    const options = argv.slice(0, -1);
    const refused = options.filter((a) => REFUSED.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) fail(`flag refused: ${refused.join(" ")}`, 64);
  },
  probe(argv) {
    if (argv[0] === "--version") return "Muse Code 1.2.1 (1.2.1-R2847.1)\n";
    if (argv[0] === "exec" && argv[1] === "--help") {
      return "SYNTHETIC help: --json --prompt-file --approval-mode --sandbox-network --worktree --session-id\n";
    }
    return undefined;
  },
  session(argv) {
    return { token: "{{SESSION_ID}}", value: opt(argv.slice(0, -1), "--session-id") };
  },
  prompt(argv) {
    const last = argv.at(-1) ?? "";
    return last.startsWith("-") ? "" : last;
  },
  requireSynthetic: true,
};
