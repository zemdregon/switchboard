/**
 * Generated-input properties for the Git-write detector (`gitWriteInCommand`: FR-GIT-01, ADR-0014, NFR-MAINT-06,
 * T8.11). Every generated Git write — through quoting, environment prefixes, path variants, command launchers,
 * compound lines and `gh` — is refused (a `write` or fail-closed `uncertain` verdict). Deterministic: fixed seed.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GIT_WRITE_SUBCOMMANDS, gitWriteInCommand } from "./git-write.js";

/** Fixed so a CI failure reproduces locally; bump only with the reason recorded. */
const SEED = 811138;
const NUM_RUNS = 100;

const alnum = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
/** Filler that stays one plain word: never dynamic (`$`, backtick, glob) and never an option or separator. */
const filler = () =>
  fc
    .array(fc.constantFrom(...alnum, "-", "_", ".", "/"), { minLength: 1, maxLength: 8 })
    .map((chars) => chars.join(""));

describe("gitWriteInCommand properties (T8.11)", () => {
  it("every generated write subcommand is refused, however its words are quoted", () => {
    fc.assert(
      fc.property(fc.constantFrom(...GIT_WRITE_SUBCOMMANDS), fc.boolean(), filler(), (sub, quotedProgram, arg) => {
        const program = quotedProgram ? "'git'" : "git";
        for (const command of [
          `${program} ${sub}`,
          `${program} ${sub} ${arg}`,
          `/usr/bin/git ${sub} ${arg}`,
          `git-${sub} ${arg}`,
        ]) {
          expect(gitWriteInCommand(command), command).toBeDefined();
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it("quoting the subcommand letter by letter never hides a write", () => {
    fc.assert(
      fc.property(fc.constantFrom(...GIT_WRITE_SUBCOMMANDS), (sub) => {
        for (const spelled of [`'${sub}'`, `"${sub}"`, `\\${sub[0]}${sub.slice(1)}`]) {
          const command = `git ${spelled}`;
          expect(gitWriteInCommand(command), command).toBeDefined();
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED + 1 },
    );
  });

  it("environment prefixes, path variants and launchers never hide a write", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GIT_WRITE_SUBCOMMANDS),
        fc.constantFrom("FOO=bar", "GIT_SSH=false", "GIT_CONFIG_COUNT=0", "GIT_DIR=/tmp/r"),
        fc.constantFrom("git", "/usr/bin/git", "/bin/git"),
        fc.constantFrom("env", "sudo", "nice", "nohup", "xargs", "timeout 5", "sh -c", "eval"),
        (sub, env, program, launcher) => {
          const inner = `${program} ${sub}`;
          const command =
            launcher === "sh -c" ? `sh -c '${inner}'` : launcher === "eval" ? `eval ${inner}` : `${launcher} ${inner}`;
          for (const line of [`${env} ${inner}`, command, `${env} ${command}`]) {
            expect(gitWriteInCommand(line), line).toBeDefined();
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED + 2 },
    );
  });

  it("a write hidden behind a compound line or substitution is still refused", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GIT_WRITE_SUBCOMMANDS),
        fc.constantFrom(";", "&&", "||", "|", "\n"),
        filler(),
        (sub, separator, arg) => {
          for (const command of [
            `git status ${separator} git ${sub} ${arg}`,
            `echo ${arg} ${separator} git ${sub}`,
            `$(git ${sub} ${arg})`,
            `git stash ${separator} git ${sub}`,
          ]) {
            expect(gitWriteInCommand(command), JSON.stringify(command)).toBeDefined();
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED + 3 },
    );
  });

  it("gh stays refused whatever it is asked to publish", () => {
    fc.assert(
      fc.property(filler(), filler(), (verb, arg) => {
        for (const command of [`gh ${verb} ${arg}`, `gh ${verb}`, `env gh ${verb} ${arg}`]) {
          expect(gitWriteInCommand(command), command).toBeDefined();
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED + 4 },
    );
  });
});
