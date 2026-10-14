// Cursor dialect of the shared replay helper (T4.45, FR-ADP-11): headless invocation `--print --output-format stream-json --trust --force`
// with prompt on stdin (src/adapters/cursor/adapter.ts). Session placeholder: {{SESSION_ID}}.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const REFUSED_FLAGS = ["--dangerously-skip-permissions", "--yolo", "--always-approve", "--approve-mcps", "--full-auto"];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (!argv.includes("--print") || opt(argv, "--output-format") !== "stream-json") {
      fail("expected cursor-agent --print --output-format stream-json", 64);
    }
    if (!argv.includes("--trust") || !argv.includes("--force")) {
      fail("expected --trust --force for compiled cursor-agent run", 64);
    }
    const refused = argv.filter((a) => REFUSED_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) {
      fail(`bypass flag refused: ${refused.join(" ")}`, 64);
    }
  },
  probe(argv) {
    if (argv.includes("--version")) {
      return "2026.10.12-d47ca18\n";
    }
    if (argv.includes("--help")) {
      return "SYNTHETIC help: --print --output-format --trust --force --resume --sandbox\n";
    }
    if (argv[0] === "status" && argv.includes("--format") && opt(argv, "--format") === "json") {
      return `${JSON.stringify({ isAuthenticated: true })}\n`;
    }
    return undefined;
  },
  session(argv) {
    const r = argv.indexOf("--resume");
    return {
      token: "{{SESSION_ID}}",
      value: r >= 0 ? argv[r + 1] : undefined,
    };
  },
  requireSynthetic: true,
};
