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

/**
 * The words that make `sub` a write: every subcommand in the list is one on its own except `git branch`, whose bare
 * and listing forms are read-only, so it is given a delete (`-D x`).
 */
const writeForm = (sub: string): string => (sub === "branch" ? "branch -D x" : sub);

describe("gitWriteInCommand properties (T8.11)", () => {
  it("every generated write subcommand is refused, however its words are quoted", () => {
    fc.assert(
      fc.property(fc.constantFrom(...GIT_WRITE_SUBCOMMANDS), fc.boolean(), filler(), (sub, quotedProgram, arg) => {
        const program = quotedProgram ? "'git'" : "git";
        for (const command of [
          `${program} ${writeForm(sub)}`,
          `${program} ${writeForm(sub)} ${arg}`,
          `/usr/bin/git ${writeForm(sub)} ${arg}`,
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
          const command = `git ${spelled}${writeForm(sub).slice(sub.length)}`;
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
          const inner = `${program} ${writeForm(sub)}`;
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
            `git status ${separator} git ${writeForm(sub)} ${arg}`,
            `echo ${arg} ${separator} git ${writeForm(sub)}`,
            `$(git ${writeForm(sub)} ${arg})`,
            `git stash ${separator} git ${writeForm(sub)}`,
          ]) {
            expect(gitWriteInCommand(command), JSON.stringify(command)).toBeDefined();
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED + 3 },
    );
  });

  it("a git- subprogram behind a launcher is refused, a git- file path argument is not", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GIT_WRITE_SUBCOMMANDS, "receive-pack", "upload-pack"),
        fc.constantFrom("env", "sudo", "nice", "nohup", "xargs", "timeout 600"),
        fc.constantFrom("ts", "test.ts", "js", "mjs", "json", "md"),
        filler(),
        (sub, launcher, ext, dir) => {
          for (const command of [
            `${launcher} git-${sub}`,
            `${launcher} /usr/lib/git-core/git-${sub} ${dir}`,
            `${launcher} cat ${dir}/git-${sub}.${ext}; git-${sub}`,
          ]) {
            expect(gitWriteInCommand(command), command).toBeDefined();
          }
          for (const command of [
            `${launcher} npx vitest run ${dir}/git-${sub}.${ext}`,
            `${launcher} cat ${dir}/git-${sub}.${ext}`,
            `cat ${dir}/git-${sub}.${ext}`,
          ]) {
            expect(gitWriteInCommand(command), command).toBeUndefined();
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED + 5 },
    );
  });

  it("listing forms of git branch are read-only, any branch-changing option makes them a write", () => {
    const listing = [
      "",
      "--show-current",
      "--list",
      "-l",
      "-a",
      "-r",
      "-v",
      "-vv",
      "-av",
      "--all",
      "--remotes",
      "--verbose",
      "--contains",
      "--merged",
      "--no-merged main",
      "--contains HEAD",
      "--points-at HEAD",
      "--sort=-committerdate",
      "--sort refname",
      "--format='%(refname:short)'",
      "--color=always",
      "--no-color",
    ];
    const writes = [
      "-d",
      "-D",
      "--delete",
      "-m",
      "-M",
      "--move",
      "-c",
      "-C",
      "--copy",
      "-f",
      "--force",
      "-u origin/main",
      "--set-upstream-to=origin/main",
      "--unset-upstream",
      "--edit-description",
      "-t",
      "--track",
      "--no-track",
      "--create-reflog",
      "--recurse-submodules",
      "-ad",
      "-vD",
      "--del",
    ];
    fc.assert(
      fc.property(
        fc.subarray(listing, { maxLength: 3 }),
        fc.constantFrom(...writes),
        fc.nat(3),
        fc.constantFrom("git", "/usr/bin/git", "git -C .", "timeout 600 git", "env git"),
        filler(),
        (opts, write, at, program, name) => {
          const read = `${program} branch ${opts.join(" ")}`.trimEnd();
          expect(gitWriteInCommand(read), read).toBeUndefined();
          const words = [...opts];
          words.splice(Math.min(at, words.length), 0, write);
          for (const command of [
            `${program} branch ${words.join(" ")} ${name}`,
            `${program} branch ${words.join(" ")}`,
            `${read} && git branch ${write} ${name}`,
          ]) {
            expect(gitWriteInCommand(command), command).toBeDefined();
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED + 6 },
    );
  });

  it("a plain branch name creates a branch unless list mode makes it a pattern", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9/_.-]{0,10}$/), (name) => {
        for (const command of [`git branch ${name}`, `git branch -v ${name}`, `git branch -- ${name}`]) {
          expect(gitWriteInCommand(command), command).toBeDefined();
        }
        for (const command of [
          `git branch --list ${name}`,
          `git branch -l ${name}`,
          `git branch --merged main ${name}`,
        ]) {
          expect(gitWriteInCommand(command), command).toBeUndefined();
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED + 7 },
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
