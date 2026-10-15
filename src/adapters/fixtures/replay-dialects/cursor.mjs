// Cursor dialect of the shared replay helper (T4.45, FR-ADP-11): headless invocation `--print --output-format stream-json --trust --force [--resume <id>]`
// with prompt on stdin (src/adapters/cursor/adapter.ts). Session placeholder: {{SESSION_ID}}.

// Flags the adapter refuses: shared BYPASS_FLAGS, Cursor-declared bypass flags and short flags (providers.ts),
// plus flags the adapter never compiles (protocol.ts).
const REFUSED_FLAGS = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
  "--auto-review",
  "--worktree",
  "--worktree-base",
  "--skip-worktree-setup",
  "--workspace",
  "--add-dir",
  "--plugin-dir",
  "--api-key",
  "--auth-token",
  "--header",
  "--endpoint",
  "--sandbox",
  "--continue",
  "--model",
  "--mode",
  "--permission-mode",
  "--allow",
  "--deny",
  "-w",
  "-H",
  "-e",
  "-f",
];

const REFUSED_ENV = ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME"];

const ALLOWED_FLAGS = new Set(["--print", "--output-format", "--trust", "--force", "--resume"]);

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (argv.includes("--")) {
      fail("`--` is not expected in compiled cursor-agent argv", 64);
    }

    // Refused environment variables (credentials and config redirection)
    const leaked = REFUSED_ENV.filter((k) => Object.hasOwn(process.env, k));
    if (leaked.length > 0) {
      fail(`environment refused: ${leaked.join(" ")}`, 64);
    }

    // Refused bypass flags and never-emitted flags
    const refused = argv.filter((a) => REFUSED_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) {
      fail(`flag refused: ${refused.join(" ")}`, 64);
    }

    // Flag occurrences
    const printCount = argv.filter((a) => a === "--print").length;
    if (printCount !== 1) {
      fail("expected --print exactly once", 64);
    }

    const formatIndices = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--output-format") formatIndices.push(i);
    }
    if (formatIndices.length !== 1) {
      fail("expected exactly one --output-format stream-json", 64);
    }
    const formatVal = argv[formatIndices[0] + 1];
    if (formatVal !== "stream-json") {
      fail("expected --output-format stream-json", 64);
    }
    if (argv.some((a) => a.startsWith("--output-format="))) {
      fail("expected --output-format stream-json as two words", 64);
    }

    const trustCount = argv.filter((a) => a === "--trust").length;
    if (trustCount !== 1) {
      fail("expected --trust exactly once", 64);
    }

    const forceCount = argv.filter((a) => a === "--force").length;
    if (forceCount !== 1) {
      fail("expected --force exactly once", 64);
    }

    const resumeIndices = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--resume") resumeIndices.push(i);
    }
    if (resumeIndices.length > 1) {
      fail("expected at most one --resume <id>", 64);
    }
    if (resumeIndices.length === 1) {
      const idx = resumeIndices[0];
      if (idx + 1 >= argv.length) {
        fail("expected --resume <id> with an id", 64);
      }
      const id = argv[idx + 1];
      if (typeof id !== "string" || id === "" || id.startsWith("-")) {
        fail("expected --resume <id> with a safe non-flag id", 64);
      }
    }
    if (argv.some((a) => a.startsWith("--resume="))) {
      fail("expected --resume <id> as two words", 64);
    }

    // Check for unknown flags or unexpected positional arguments (prompt is on stdin)
    for (let i = 0; i < argv.length; i++) {
      const word = argv[i];
      if (word.startsWith("-")) {
        const flagName = word.split("=")[0];
        if (!ALLOWED_FLAGS.has(flagName)) {
          fail(`unexpected flag: ${word}`, 64);
        }
        if (word === "--output-format" || word === "--resume") {
          i += 1; // skip argument
        }
      } else {
        fail(`unexpected positional argument: ${word}`, 64);
      }
    }
  },
  probe(argv) {
    if (argv.length === 1 && argv[0] === "--version") {
      return "2026.10.12-d47ca18\n";
    }
    if (argv.length === 1 && argv[0] === "--help") {
      return "SYNTHETIC help: --print --output-format --trust --force --resume --sandbox\n";
    }
    if (argv.length === 3 && argv[0] === "status" && argv[1] === "--format" && argv[2] === "json") {
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
