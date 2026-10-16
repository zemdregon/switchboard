// Test-only, SYNTHETIC stand-in for `muse` (T4.72): no Muse Code binary is run. Launched as `node fake-muse.mjs ...`
// through the adapter's `launcherArgs`. `--version` and `exec --help` print the synthetic text from `cases.ts`; `exec`
// prints one JSON line naming the environment variables it received (names only, never values) and the argv it got,
// and writes nothing to disk.
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("Muse Code 1.2.1 (1.2.1-R2847.1)\n");
} else if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write(
    "Usage: muse exec [OPTIONS] [PROMPT]\n" +
      "      --json\n" +
      "      --prompt-file <PATH>\n" +
      "      --approval-mode <MODE>\n" +
      "      --sandbox-network <MODE>\n" +
      "  -w, --worktree <MODE>\n" +
      "      --session-id <UUID>\n",
  );
} else if (args[0] === "exec") {
  process.stdout.write(
    `${JSON.stringify({ synthetic: true, envNames: Object.keys(process.env).sort(), argv: args })}\n`,
  );
} else {
  process.stderr.write(`fake-muse: unsupported arguments ${JSON.stringify(args)}\n`);
  process.exitCode = 2;
}
