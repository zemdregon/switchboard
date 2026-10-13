// Test-only: registers ./ts-hooks.mjs (see there). Used as `node --import <this file>`.
import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);
