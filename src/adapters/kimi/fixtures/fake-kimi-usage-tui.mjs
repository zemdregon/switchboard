#!/usr/bin/env node
// SYNTHETIC stand-in for the Kimi Code TUI in the usage reader test (FR-CAP-13, ADR-0079). No `kimi` is run.
// It runs under `script` (a pseudo-terminal), switches the terminal to raw mode like the TUI, draws a prompt with a
// `context:` status line, echoes typed characters as the TUI's input line and, on Enter after exactly `/usage`, prints
// the recorded panel (`usage-tui-2.1.1.raw`). Two Ctrl-C (0x03) exit, as in the TUI.
// `trust` first shows the folder trust dialog naming its working directory (as 2.1.1 does in an untrusted folder);
// Enter answers it, recorded by a `trust-answered` file in that directory, and the prompt follows. `trust-other` shows
// the dialog naming another path.
// Usage: node fake-kimi-usage-tui.mjs --scenario=<ok|not-logged-in|hang|env|trust|trust-other> <fixture.raw>
import { readFileSync, realpathSync, writeFileSync } from "node:fs";

const scenario = (process.argv.find((a) => a.startsWith("--scenario=")) ?? "--scenario=ok").slice(11);
const fixture = process.argv.at(-1);
const out = (s) => process.stdout.write(s);
const box = (s) => `\x1b[2K │ ${s.padEnd(94)} │\r\n`;

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

const prompt = () => {
  out(box(">"));
  out(`\x1b[38;2;90;90;90m K2.8 Preview\x1b[39m\r\n                    context: 0% (0/1M)\r`);
};
let inDialog = scenario === "trust" || scenario === "trust-other";
if (scenario === "not-logged-in") {
  out(box('LLM not set, send "/login" to login'));
  out("                                                     context: 0% (0/0)\r\n");
} else if (inDialog) {
  const shown = scenario === "trust" ? realpathSync(process.cwd()) : "/tmp/some-other-folder";
  out("\r\n  \x1b[1mTrust this folder?\x1b[22m\r\n  ↑↓ navigate · Enter select · Esc exit\r\n");
  out(`  ${shown}\r\n  No project integrations or instructions to activate.\r\n`);
  out("   \x1b[36m❯ Trust and continue\x1b[39m\r\n     Exit\r\n");
} else if (scenario !== "hang") {
  prompt();
}
if (scenario === "env") {
  // Print the environment names (never values) so the test can check the allowlist through the real `script`.
  out(`\r\nENV-NAMES ${Object.keys(process.env).sort().join(",")}\r\n`);
}

let input = "";
let interrupts = 0;
process.stdin.on("data", (chunk) => {
  for (const ch of chunk.toString("utf8")) {
    if (ch === "\x03") {
      interrupts += 1;
      if (interrupts >= 2) {
        out("\r\n Bye!\r\n");
        process.exit(0);
      }
      out(" Press Ctrl+C again to exit\r");
      continue;
    }
    if (scenario === "hang") continue;
    if (inDialog) {
      if (ch === "\r") {
        writeFileSync("trust-answered", "");
        inDialog = false;
        prompt();
      }
      continue;
    }
    if (ch === "\r") {
      if (input === "/usage") out(readFileSync(fixture, "utf8"));
      input = "";
      continue;
    }
    input += ch;
    out(`\r${box(`> ${input}`).trimEnd()}\r`);
    if (input.startsWith("/u")) out(`${box(`  → ${input === "/u" ? "undo" : "usage"}   Show plan quotas`)}`);
  }
});
