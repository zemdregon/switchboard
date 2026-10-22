#!/usr/bin/env node
import os from "node:os";
import { createTerminalRunner } from "../adapters/terminal-run.js";
import { createCopilotQuotaReader } from "../usage/copilot-quota.js";
import { runCli } from "./main.js";

// Anything escaping main (import/init failure) is caught in runCli: `switchboard: <message>` on
// stderr (no stack unless SWITCHBOARD_DEBUG=1) with the internal-error exit code.
process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  homedir: os.homedir(),
  // ADR-0079 (FR-CAP-13): the pseudo-terminal for TUI-only usage readers (Kimi Code), in `<data_dir>/probes`.
  providerUsageTerminal: (probeRoot) => createTerminalRunner({ probeRoot }),
  // ADR-0081: the operator's own `gh` reads the Copilot quota (only while `capacity.copilot_quota` is on).
  copilotQuota: createCopilotQuotaReader,
});
