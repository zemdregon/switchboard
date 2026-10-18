// Scratch dialect of the shared replay helper (T4.2): the SYNTHETIC T4.1 test adapter
// (src/adapters/fixtures/scratch-provider.ts) compiles the fake CLI's argv, `--scenario <name> [--resume <id>]
// --scratch-no-repo-config`, with the prompt on stdin. Scratch is not a real provider; the version text below is SYNTHETIC test data.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

// Mirrors BYPASS_FLAGS in src/adapters/audit.ts plus the scratch entry's declared bypass forms and the fake's tool
// channel flag, which the scratch adapter never emits: the replay refuses to run if any appear (defence in depth).
const REFUSED = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
  "--scratch-skip-all-checks",
  "-k",
  "--scratch-guard",
  "--tool-channel",
];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    if (argv[0] !== "--scenario" || argv[1] === undefined) fail("expected scratch --scenario <name>", 64);
    if (!argv.includes("--scratch-no-repo-config")) fail("expected --scratch-no-repo-config", 64);
    const refused = argv.filter((a) => REFUSED.some((f) => a === f || a.startsWith(`${f}=`)));
    if (refused.length > 0) fail(`flag refused: ${refused.join(" ")}`, 64);
  },
  probe(argv) {
    if (argv.includes("--version")) return "scratch-cli 0.0.1-synthetic\n";
    return undefined;
  },
  session(argv) {
    return { token: "{{SESSION_ID}}", value: opt(argv, "--resume") };
  },
  requireSynthetic: true,
};
