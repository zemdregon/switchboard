// Kimi Code dialect of the shared replay helper (T4.63, FR-ADP-11; conformance T4.65): the approved bypass cell only,
// `[--model=<alias>] --prompt=<prompt> --output-format stream-json [--session <id>]`, with the prompt in the one
// `--prompt=` argv word and stdin unused (src/adapters/kimi/adapter.ts, ADR-0049 item 1). The argv must be exactly that
// shape, in that order: any other word, a repeated or reordered flag, or a refused environment variable exits 64, so a
// wrong compile cannot pass. The ACP path is replayed by the shared fake ACP agent, not here. Session placeholder:
// {{SESSION_ID}}. The version and help text below are SYNTHETIC test data, not a claim about the real CLI.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const PROMPT = "--prompt=";
const MODEL = "--model=";
// The adapter's session id check (adapter.ts `SESSION_ID_RE`): one safe argument, never flag-like.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

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

// KIMI_CODE_HOME relocates configuration, sessions and credentials ([K10]); the adapter keeps it out (envAllowlist
// PATH and HOME only), so its presence means the supervisor leaked the controller's environment.
const REFUSED_ENV = ["KIMI_CODE_HOME"];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    const leaked = REFUSED_ENV.filter((k) => Object.hasOwn(process.env, k));
    if (leaked.length > 0) fail(`environment refused: ${leaked.join(" ")}`, 64);
    const refused = argv.filter((a) => REFUSED.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) fail(`flag refused: ${refused.join(" ")}`, 64);
    let i = 0;
    if (argv[i]?.startsWith(MODEL)) {
      if (!SAFE_ID.test(argv[i].slice(MODEL.length))) fail("expected --model=<alias> with a safe alias", 64);
      i += 1;
    }
    if (!argv[i]?.startsWith(PROMPT)) fail("expected exactly one --prompt=<prompt> word", 64);
    i += 1;
    if (argv[i] !== "--output-format" || argv[i + 1] !== "stream-json") {
      fail("expected kimi --output-format stream-json", 64);
    }
    i += 2;
    if (argv[i] === "--session") {
      if (!SAFE_ID.test(argv[i + 1] ?? "")) fail("expected --session <id> with a safe id", 64);
      i += 2;
    }
    if (i !== argv.length) fail(`unexpected argv: ${argv.slice(i).join(" ")}`, 64);
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
