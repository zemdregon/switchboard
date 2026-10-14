// Codex dialect of the shared replay helper (T4.3): `exec --json ... [resume <id>]` with the prompt on stdin
// (src/adapters/codex/adapter.ts). Session placeholder: __RESUME_ID__, replaced only on a resume. The version and help
// text below are SYNTHETIC test data, not a claim about the real CLI.

// Mirrors BYPASS_FLAGS in src/adapters/audit.ts: the replay refuses to run if any appear (defence in depth).
const BYPASS = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (argv[0] !== "exec" || !argv.includes("--json")) fail(`unexpected argv: ${argv.join(" ")}`, 64);
    const bypass = argv.filter((a) => BYPASS.some((f) => a === f || a.startsWith(`${f}=`)));
    if (bypass.length > 0) fail(`bypass flag refused: ${bypass.join(" ")}`, 64);
  },
  probe(argv) {
    if (argv[0] === "--version") return "codex-cli 0.0.1 (SYNTHETIC replay, not a real version)\n";
    if (argv[0] === "exec" && argv[1] === "--help") {
      return "SYNTHETIC help: --json --sandbox <MODE> --ignore-user-config --ignore-rules\n";
    }
    return undefined;
  },
  session(argv) {
    const r = argv.indexOf("resume");
    return { token: "__RESUME_ID__", value: r >= 0 ? argv[r + 1] : undefined };
  },
  requireSynthetic: true,
};
