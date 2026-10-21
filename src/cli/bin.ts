#!/usr/bin/env node
import os from "node:os";
import { runCli } from "./main.js";
import { defaultProviderUsage } from "./provider-usage.js";

// Anything escaping main (import/init failure) is caught in runCli: `switchboard: <message>` on
// stderr (no stack unless SWITCHBOARD_DEBUG=1) with the internal-error exit code.
process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  homedir: os.homedir(),
  // FR-CAP-13 (ADR-0079): provider-reported usage through the provider CLI's own usage display.
  providerUsage: (ids, ctx) => defaultProviderUsage(ids, process.env, ctx.dataDir),
});
