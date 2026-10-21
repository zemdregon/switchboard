// Grok Build dialect of the shared replay helper (T4.25, FR-ADP-11): `--no-auto-update --single=<prompt>
// --output-format streaming-json --sandbox <profile> [--disable-web-search] --always-approve [-r <id>]` with the prompt
// in the one `--single=` argv word and stdin unused (src/adapters/grok/adapter.ts). Session placeholder:
// {{SESSION_ID}}. The version and help text below are SYNTHETIC test data, not a claim about the real CLI.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const SINGLE = "--single=";
const SANDBOX_PROFILES = ["off", "strict", "read-only", "workspace"];

// Mirrors BYPASS_FLAGS in src/adapters/audit.ts minus `--always-approve` (the one bypass flag the approved Grok cell
// compiles, checked below to travel with `--sandbox`), plus flags the adapter never emits (adapter.ts header): the
// replay refuses to run if any appear (defence in depth).
const REFUSED = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--approve-mcps",
  "--full-auto",
  "--permission-mode",
  "--allow",
  "--allowed-tools",
  "--trust",
  "--worktree",
  "-w",
  "--fork-session",
  "-p",
];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (opt(argv, "--output-format") !== "streaming-json" || !argv.includes("--no-auto-update")) {
      fail("expected grok --no-auto-update --output-format streaming-json", 64);
    }
    if (argv.filter((a) => a.startsWith(SINGLE)).length !== 1 || argv.includes("--single")) {
      fail("expected exactly one --single=<prompt> word", 64);
    }
    // [R2] L613 to L615: the permission mode is never compiled without the sandbox profile.
    if (!argv.includes("--always-approve") || !SANDBOX_PROFILES.includes(opt(argv, "--sandbox") ?? "")) {
      fail("expected --always-approve together with --sandbox off|strict|read-only|workspace", 64);
    }
    const refused = argv.filter((a) => REFUSED.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) fail(`flag refused: ${refused.join(" ")}`, 64);
  },
  probe(argv) {
    if (argv[0] === "version") return "grok 0.0.1 (synthetic) [stable]\n";
    if (argv[0] === "--help") {
      return "SYNTHETIC help: --single --output-format --sandbox --allow --deny --resume --always-approve\n";
    }
    return undefined;
  },
  session(argv) {
    return { token: "{{SESSION_ID}}", value: opt(argv, "-r") };
  },
  prompt(argv) {
    const word = argv.find((a) => a.startsWith(SINGLE));
    return word === undefined ? "" : word.slice(SINGLE.length);
  },
  requireSynthetic: true,
};
