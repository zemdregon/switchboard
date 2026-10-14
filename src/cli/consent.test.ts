import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger/index.js";
import { normalizePairingCode, PairingCodeStore } from "../mcp/oauth-pairing.js";
import { isPassphraseHash, verifyPassphrase } from "../mcp/oauth-passphrase.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-auth-")));
  const repos = path.join(tmp, "repos");
  mkdirSync(repos);
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [repos],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    ...extra,
  };
  const code = await main(args, io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("switchboard consent (T13.8)", () => {
  it("consent pair prints a one-time code and the ledger keeps only its hash", async () => {
    const r = await run(["consent", "pair", "--json", "--config", configPath]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { pairing_code: string; expires_at: string };
    const normalized = normalizePairingCode(report.pairing_code);
    expect(normalized).toBeDefined();
    const ledger = readdirSync(dataDir)
      .filter((f) => f.startsWith("ledger"))
      .map((f) => readFileSync(path.join(dataDir, f)).toString("latin1"))
      .join("\n");
    expect(ledger).not.toContain(report.pairing_code);
    expect(ledger).not.toContain(normalized as string);
    const db = openLedger(dataDir);
    try {
      expect(new PairingCodeStore(db).redeem(report.pairing_code)).toBe(true);
      expect(new PairingCodeStore(db).redeem(report.pairing_code)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("consent hash-passphrase reads stdin, never an argument, and prints a verifiable hash", async () => {
    const passphrase = "a long operator passphrase";
    const r = await run(["consent", "hash-passphrase", "--json"], { readStdin: async () => `${passphrase}\n` });
    expect(r.code).toBe(0);
    const { passphrase_hash } = JSON.parse(r.out) as { passphrase_hash: string };
    expect(isPassphraseHash(passphrase_hash)).toBe(true);
    expect(r.out).not.toContain(passphrase);
    expect(await verifyPassphrase(passphrase, passphrase_hash)).toBe(true);

    const short = await run(["consent", "hash-passphrase"], { readStdin: async () => "short" });
    expect(short.code).toBe(1);
    expect(short.err).not.toContain("short\n");
    expect((await run(["consent", "hash-passphrase", passphrase])).code).toBe(2);
    // FR-OPS-03: still no auth or login command.
    expect((await run(["auth", "pair"])).code).toBe(2);
  }, 30_000);
});
