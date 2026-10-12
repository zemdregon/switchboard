#!/usr/bin/env node
import os from "node:os";
import { main } from "./main.js";

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  homedir: os.homedir(),
});
