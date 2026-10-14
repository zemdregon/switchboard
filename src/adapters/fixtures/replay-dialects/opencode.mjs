// OpenCode dialect of the shared replay helper (T4.55, FR-ADP-11): `run --format json --standalone [--session <id>] --
// <prompt>` with the prompt as the argv word after `--` and stdin unused (src/adapters/opencode/adapter.ts). Session
// placeholder: {{SESSION_ID}}. The version and help text below are SYNTHETIC test data, not a claim about the real CLI.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

// Mirrors BYPASS_FLAGS in src/adapters/audit.ts plus OpenCode's declared `--auto` (providers.ts): the replay refuses
// to run if any appear (defence in depth).
const BYPASS = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
  "--auto",
];

/** Options before the end-of-options marker; the prompt is the one word after it. */
const options = (argv) => {
  const end = argv.indexOf("--");
  return end >= 0 ? argv.slice(0, end) : argv;
};

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    const flags = options(argv);
    if (flags[0] !== "run" || opt(flags, "--format") !== "json" || !flags.includes("--standalone")) {
      fail("expected opencode run --format json --standalone", 64);
    }
    const end = argv.indexOf("--");
    if (end < 0 || end !== argv.length - 2) fail("expected exactly one prompt word after --", 64);
    const bypass = flags.filter((a) => BYPASS.some((f) => a === f || a.startsWith(`${f}=`)));
    if (bypass.length > 0) fail(`bypass flag refused: ${bypass.join(" ")}`, 64);
  },
  probe(argv) {
    if (argv[0] === "--version") return "0.0.1\n";
    if (argv[0] === "run" && argv[1] === "--help") {
      return "SYNTHETIC help: --format --standalone --session --continue --auto\n";
    }
    return undefined;
  },
  session(argv) {
    return { token: "{{SESSION_ID}}", value: opt(options(argv), "--session") };
  },
  prompt(argv) {
    const end = argv.indexOf("--");
    return end >= 0 ? (argv[end + 1] ?? "") : "";
  },
  requireSynthetic: true,
};
