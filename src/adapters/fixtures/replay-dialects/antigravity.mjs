// Antigravity dialect of the shared replay helper (T4.35, FR-ADP-11): `--prompt=<prompt> --output-format stream-json
// --dangerously-skip-permissions [--conversation <id>]` with the prompt in the one `--prompt=` argv word and stdin
// unused, and `AGY_CLI_DISABLE_AUTO_UPDATE=true` in the environment (src/adapters/antigravity/adapter.ts). Session
// placeholder: {{SESSION_ID}}. The version and help text below are SYNTHETIC test data, not a claim about the real CLI.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const PROMPT = "--prompt=";
const SKIP = "--dangerously-skip-permissions";

// Mirrors BYPASS_FLAGS in src/adapters/audit.ts and the Antigravity `bypassFlags` in src/adapters/providers.ts minus
// `--dangerously-skip-permissions` (the one bypass flag the approved cell compiles, checked below), plus flags the
// adapter never emits (adapter.ts header) and the bare prompt spellings: the replay refuses to run if any appear
// (defence in depth).
const REFUSED = [
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
  "-dangerously-skip-permissions",
  "--remote-control",
  "-remote-control",
  "--gemini_dir",
  "-gemini_dir",
  "--add-dir",
  "-add-dir",
  "--sandbox",
  "--mode",
  "--model",
  "--continue",
  "-c",
  "--print-timeout",
  "--print",
  "--prompt",
  "-p",
];

// API-key mode stays disabled (adapter.ts ANTIGRAVITY_ENV_ALLOWLIST): none of these may reach the provider process.
const REFUSED_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (opt(argv, "--output-format") !== "stream-json") fail("expected agy --output-format stream-json", 64);
    if (argv.filter((a) => a.startsWith(PROMPT)).length !== 1) fail("expected exactly one --prompt=<prompt> word", 64);
    if (argv.filter((a) => a === SKIP).length !== 1) fail(`expected ${SKIP} exactly once (approved bypass cell)`, 64);
    const flags = argv.filter((a) => !a.startsWith(PROMPT));
    const refused = flags.filter((a) => REFUSED.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) fail(`flag refused: ${refused.join(" ")}`, 64);
    if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== "true") fail("expected AGY_CLI_DISABLE_AUTO_UPDATE=true", 64);
    const leaked = REFUSED_ENV.filter((k) => Object.hasOwn(process.env, k));
    if (leaked.length > 0) fail(`environment refused: ${leaked.join(" ")}`, 64);
  },
  probe(argv) {
    if (argv[0] === "--version") return "0.0.1\n";
    if (argv[0] === "--help") {
      return "SYNTHETIC help: --prompt --output-format --dangerously-skip-permissions --conversation\n";
    }
    return undefined;
  },
  session(argv) {
    return { token: "{{SESSION_ID}}", value: opt(argv, "--conversation") };
  },
  prompt(argv) {
    const word = argv.find((a) => a.startsWith(PROMPT));
    return word === undefined ? "" : word.slice(PROMPT.length);
  },
  requireSynthetic: true,
};
