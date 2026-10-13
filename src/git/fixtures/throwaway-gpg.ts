/**
 * Test-only (excluded from the build): a THROWAWAY, unprotected GnuPG key generated in a fresh temporary `GNUPGHOME`,
 * plus a temporary `HOME` whose `.gitconfig` names that key as `user.signingkey` (T9.10, LLD §12.3.1). Nothing here
 * reads, copies or prints a real key, keyring, agent socket or Git configuration: every path is a new temporary
 * directory and is removed (and its `gpg-agent` stopped) by `dispose()`. Tests that need it skip cleanly when `gpg` is
 * not installed ({@link gpgAvailable}).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** True when a `gpg` binary runs; tests that sign use `describe.skipIf(!gpgAvailable())`. */
export function gpgAvailable(): boolean {
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
    return true;
  } catch {
    return false;
  }
}

export interface ThrowawaySigner {
  /** Temporary home directory holding `.gitconfig` (the stand-in for the operator's global Git configuration). */
  readonly home: string;
  /** Temporary `GNUPGHOME` holding only the throwaway key. Short path: gpg-agent's socket must fit the kernel limit. */
  readonly gnupgHome: string;
  /** Fingerprint of the throwaway key (a public identifier, not key material). */
  readonly fingerprint: string;
  /** `PATH`, `HOME` and `GNUPGHOME` for a controller-side signing call. */
  readonly env: Record<string, string>;
  /** Environment for `git verify-commit` against the throwaway keyring (no global or system Git configuration). */
  readonly verifyEnv: Record<string, string>;
  dispose(): void;
}

/** Create the throwaway key and configuration. `gitconfig` replaces the default `.gitconfig` body when given. */
export function createThrowawaySigner(opts: { gitconfig?: (fingerprint: string) => string } = {}): ThrowawaySigner {
  const gnupgHome = mkdtempSync(path.join(tmpdir(), "sbg-"));
  chmodSync(gnupgHome, 0o700);
  const home = mkdtempSync(path.join(tmpdir(), "sbh-"));
  const base = { PATH: process.env.PATH ?? "", GNUPGHOME: gnupgHome, HOME: home };
  try {
    execFileSync(
      "gpg",
      [
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--quick-gen-key",
        "Throwaway Test Key <throwaway@example.test>",
        "ed25519",
        "sign",
        "never",
      ],
      { env: base, stdio: "ignore" },
    );
    const listing = execFileSync("gpg", ["--batch", "--list-secret-keys", "--with-colons"], {
      env: base,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const fpr = listing
      .split("\n")
      .find((l) => l.startsWith("fpr:"))
      ?.split(":")[9];
    if (!fpr) throw new Error("throwaway key generation produced no fingerprint");
    const body = opts.gitconfig ? opts.gitconfig(fpr) : `[user]\n\tsigningkey = ${fpr}\n[gpg]\n\tformat = openpgp\n`;
    writeFileSync(path.join(home, ".gitconfig"), body);
    return {
      home,
      gnupgHome,
      fingerprint: fpr,
      env: { ...base },
      verifyEnv: { PATH: base.PATH, GNUPGHOME: gnupgHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      dispose: () => dispose(gnupgHome, home),
    };
  } catch (err) {
    dispose(gnupgHome, home);
    throw err;
  }
}

function dispose(gnupgHome: string, home: string): void {
  try {
    execFileSync("gpgconf", ["--homedir", gnupgHome, "--kill", "gpg-agent"], {
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "", GNUPGHOME: gnupgHome },
    });
  } catch {
    // no agent was started, or gpgconf is missing: nothing to stop
  }
  rmSync(gnupgHome, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
