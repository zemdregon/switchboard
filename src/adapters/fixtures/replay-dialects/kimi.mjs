// Kimi Code dialect of the shared replay helper (T4.63, FR-ADP-11): the approved bypass cell only,
// `[--model=<alias>] --prompt=<prompt> --output-format stream-json [--session <id>]`, with the prompt in the one
// `--prompt=` argv word and stdin unused (src/adapters/kimi/adapter.ts, ADR-0049 item 1). The ACP path is replayed by
// the shared fake ACP agent, not here. Session placeholder: {{SESSION_ID}}. The version and help text below are
// SYNTHETIC test data, not a claim about the real CLI.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const PROMPT = "--prompt=";

// The flags the registry declares bypass-class for Kimi Code plus those the adapter never emits (adapter.ts header):
// the replay refuses to run if any appear (defence in depth).
const REFUSED = [
  "--yolo",
  "-y",
  "--auto",
  "--plan",
  "-p",
  "--continue",
  "-c",
  "--agent",
  "--agent-file",
  "--skills-dir",
  "--add-dir",
  "-S",
  "-r",
  "acp",
];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (opt(argv, "--output-format") !== "stream-json") fail("expected kimi --output-format stream-json", 64);
    if (argv.filter((a) => a.startsWith(PROMPT)).length !== 1 || argv.includes("--prompt")) {
      fail("expected exactly one --prompt=<prompt> word", 64);
    }
    const refused = argv.filter((a) => REFUSED.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) fail(`flag refused: ${refused.join(" ")}`, 64);
  },
  probe(argv) {
    if (argv[0] === "--version") return "0.0.1\n";
    if (argv[0] === "--help") {
      return "SYNTHETIC help: --session --model --prompt --output-format\nCommands:\n  acp\n";
    }
    return undefined;
  },
  session(argv) {
    return { token: "{{SESSION_ID}}", value: opt(argv, "--session") };
  },
  prompt(argv) {
    const word = argv.find((a) => a.startsWith(PROMPT));
    return word === undefined ? "" : word.slice(PROMPT.length);
  },
  requireSynthetic: true,
};
