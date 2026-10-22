/**
 * `switchboard mcp oauth ...`: profile-bound one-time codes (profile checks, TTL bounds, single live code, audit
 * without the code), the client and token views (never a token value or hash) and revocation (audited).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger/index.js";
import { OAuthAuditLog } from "../mcp/oauth-audit.js";
import { OAuthClientStore } from "../mcp/oauth-clients.js";
import { normalizePairingCode, PairingCodeStore } from "../mcp/oauth-pairing.js";
import { OAuthTokenStore } from "../mcp/oauth-tokens.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { parseCodeTtl } from "./mcp-oauth.js";

const RESOURCE = "https://sb.example.test/mcp";
const NOW = new Date("2026-10-21T09:00:00.000Z");

let tmp: string;
let dataDir: string;
let configPath: string;

function writeConfig(http: Record<string, unknown> | undefined, extraClients: Record<string, unknown>[] = []): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(tmp, "repos")],
      mcp_clients: [
        { id: "grok-bot", max_trust_profile: "edit-untrusted" },
        { id: "root", max_trust_profile: "privileged" },
        ...extraClients,
      ],
      ...(http !== undefined ? { transport: { http } } : {}),
    }),
  );
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-mcp-oauth-")));
  mkdirSync(path.join(tmp, "repos"));
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeConfig({ enabled: true, public_url: RESOURCE, port: 0 });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "operator",
    now: () => NOW,
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

function withDb<T>(fn: (db: ReturnType<typeof openLedger>) => T): T {
  const db = openLedger(dataDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function ledgerText(): string {
  withDb((db) => db.pragma("wal_checkpoint(TRUNCATE)"));
  return readdirSync(dataDir)
    .filter((f) => f.startsWith("ledger"))
    .map((f) => readFileSync(path.join(dataDir, f)).toString("latin1"))
    .join("\n");
}

describe("mcp oauth issue-code", () => {
  it("prints a bound code once, stores only its hash and audits the issue without it", async () => {
    const r = await run(["mcp", "oauth", "issue-code", "--client-profile", "grok-bot", "--ttl", "15m", "--json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { code: string; mcp_client: string; expires_at: string };
    expect(report.mcp_client).toBe("grok-bot");
    expect(Date.parse(report.expires_at) - NOW.getTime()).toBe(15 * 60_000);
    const normalized = normalizePairingCode(report.code) as string;
    expect(normalized).toBeDefined();
    const ledger = ledgerText();
    expect(ledger).not.toContain(report.code);
    expect(ledger).not.toContain(normalized);
    withDb((db) => {
      expect(new PairingCodeStore(db, { now: () => NOW }).lookup(report.code)).toEqual({ mcpClient: "grok-bot" });
      const events = new OAuthAuditLog(db).list();
      expect(events).toEqual([
        expect.objectContaining({ kind: "code_issued", mcp_client: "grok-bot", actor: "cli:operator" }),
      ]);
      expect(JSON.stringify(events)).not.toContain(normalized);
    });

    const text = await run(["mcp", "oauth", "issue-code", "--client-profile", "grok-bot"]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^One-time code: [0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\nClient profile: grok-bot\n/);
    // Issuing again ended the first code.
    withDb((db) => expect(new PairingCodeStore(db, { now: () => NOW }).lookup(report.code)).toBeUndefined());
  });

  it("accepts a privileged ceiling with approval required, but refuses unknown and not_required (ADR-0086)", async () => {
    writeConfig({ enabled: true, public_url: RESOURCE, port: 0 }, [
      { id: "auto", max_trust_profile: "privileged", privileged_approval: "not_required" },
    ]);
    for (const [profile, message] of [
      ["nope", /unknown mcp_clients id/],
      ["auto", /privileged_approval not_required/],
    ] as const) {
      const r = await run(["mcp", "oauth", "issue-code", "--client-profile", profile]);
      expect(r.code, profile).toBe(2);
      expect(r.err).toMatch(message);
    }
    expect((await run(["mcp", "oauth", "issue-code"])).code).toBe(2);
    withDb((db) => expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_pairing_code").get()).toEqual({ n: 0 }));
    const priv = await run(["mcp", "oauth", "issue-code", "--client-profile", "root", "--json"]);
    expect(priv.code).toBe(0);
    expect(JSON.parse(priv.out)).toMatchObject({ mcp_client: "root" });
  });

  it("issues a code for a not_required entry only with transport.http.allow_unattended_privileged (ADR-0091)", async () => {
    writeConfig({ enabled: true, public_url: RESOURCE, port: 0, allow_unattended_privileged: true }, [
      { id: "auto", max_trust_profile: "privileged", privileged_approval: "not_required" },
    ]);
    const r = await run(["mcp", "oauth", "issue-code", "--client-profile", "auto", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ mcp_client: "auto" });
  });

  it("parses --ttl as <n>s|m|h between 1 and 60 minutes", async () => {
    expect(parseCodeTtl(undefined)).toBeUndefined();
    expect(parseCodeTtl("60s")).toBe(60_000);
    expect(parseCodeTtl("90s")).toBe(90_000);
    expect(parseCodeTtl("10m")).toBe(600_000);
    expect(parseCodeTtl("1h")).toBe(3_600_000);
    for (const bad of ["59s", "61m", "2h", "0m", "10", "m", "-5m", "1.5m", "10 m", "1d"]) {
      expect(() => parseCodeTtl(bad), bad).toThrow();
    }
    const r = await run(["mcp", "oauth", "issue-code", "--client-profile", "grok-bot", "--ttl", "2h"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("between 1 and 60 minutes");
  });

  it("notes when the HTTP transport is off, and consent pair still works and ends a bound code", async () => {
    writeConfig(undefined);
    const bound = await run(["mcp", "oauth", "issue-code", "--client-profile", "grok-bot", "--json"]);
    expect(JSON.parse(bound.out).http_transport_enabled).toBe(false);
    const pair = await run(["consent", "pair", "--json"]);
    expect(pair.code).toBe(0);
    const { pairing_code } = JSON.parse(pair.out) as { pairing_code: string };
    withDb((db) => {
      const store = new PairingCodeStore(db, { now: () => NOW });
      expect(store.lookup(JSON.parse(bound.out).code)).toBeUndefined();
      expect(store.redeem(pairing_code)).toBe(true);
    });
  });
});

describe("mcp oauth clients, client, tokens and revoke", () => {
  let clientId: string;
  let raw: string[];

  beforeEach(() => {
    raw = [];
    withDb((db) => {
      const clients = new OAuthClientStore(db, { now: () => NOW });
      const tokens = new OAuthTokenStore(db, { now: () => NOW });
      const r = clients.register({ redirectUris: ["https://app.example/cb"], grantTypes: ["authorization_code"] });
      if (!r.ok) throw new Error("register");
      clientId = r.client.clientId;
      clients.approveAndBind(clientId, "grok-bot");
      const grantId = tokens.newGrantId();
      for (const kind of ["access", "refresh"] as const) {
        raw.push(tokens.issue({ kind, clientId, resource: RESOURCE, scopes: ["mcp"], ttlMs: 60_000, grantId }).token);
      }
      // Issued an hour ago for a minute: expired now.
      const earlier = new OAuthTokenStore(db, { now: () => new Date(NOW.getTime() - 3_600_000) });
      raw.push(
        earlier.issue({ kind: "access", clientId, resource: RESOURCE, scopes: ["mcp"], ttlMs: 60_000, grantId }).token,
      );
      clients.register({ redirectUris: ["https://other.example/cb"], grantTypes: ["authorization_code"] });
    });
  });

  /** No output may carry a token value or its SHA-256 hash. */
  function expectNoSecrets(text: string): void {
    for (const t of raw) {
      expect(text).not.toContain(t);
      expect(text).not.toContain(createHash("sha256").update(t).digest("hex"));
    }
  }

  it("lists clients with status, profile source and token counts", async () => {
    const r = await run(["mcp", "oauth", "clients", "--json"]);
    expect(r.code).toBe(0);
    expectNoSecrets(r.out);
    const { clients } = JSON.parse(r.out) as { clients: Record<string, unknown>[] };
    expect(clients).toHaveLength(2);
    const mine = clients.find((c) => c.client_id === clientId);
    expect(mine).toMatchObject({
      status: "approved",
      mcp_client: "grok-bot",
      mcp_client_source: "ledger_binding",
      mcp_client_eligible: true,
      bound_mcp_client: "grok-bot",
      tokens: { active: 2, expired: 1, revoked: 0 },
      last_token_issued_at: NOW.toISOString(),
    });
    const other = clients.find((c) => c.client_id !== clientId);
    expect(other).toMatchObject({ status: "pending", mcp_client: null, mcp_client_source: null });
    const text = await run(["mcp", "oauth", "clients"]);
    expectNoSecrets(text.out);
    expect(text.out).toContain(`${clientId}  approved  grok-bot (binding)`);
  });

  it("shows one client and the config map as the source when it maps the client", async () => {
    writeConfig({
      enabled: true,
      public_url: RESOURCE,
      port: 0,
      clients: [{ oauth_client_id: clientId, mcp_client: "root" }],
    });
    const r = await run(["mcp", "oauth", "client", clientId, "--json"]);
    expect(r.code).toBe(0);
    expectNoSecrets(r.out);
    expect(JSON.parse(r.out).client).toMatchObject({ mcp_client: "root", mcp_client_source: "config_map" });
    const text = await run(["mcp", "oauth", "client", clientId]);
    expectNoSecrets(text.out);
    expect(text.out).toContain("Profile:       root (config_map)");
    expect(text.out).toContain("Bound:         grok-bot at");
    const unknown = await run(["mcp", "oauth", "client", `sbc_${"Z".repeat(22)}`, "--json"]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error.code).toBe("NOT_FOUND");
  });

  it("lists token metadata only: active by default, everything with --all, per client with --client", async () => {
    const active = await run(["mcp", "oauth", "tokens", "--json"]);
    expect(active.code).toBe(0);
    expectNoSecrets(active.out);
    const { tokens } = JSON.parse(active.out) as { tokens: Record<string, unknown>[] };
    expect(tokens).toHaveLength(2);
    expect(Object.keys(tokens[0] ?? {}).sort()).toEqual(
      ["client_id", "expires_at", "id", "issued_at", "kind", "revoked", "revoked_at"].sort(),
    );
    const all = await run(["mcp", "oauth", "tokens", "--all", "--client", clientId, "--json"]);
    expect(JSON.parse(all.out).tokens).toHaveLength(3);
    const text = await run(["mcp", "oauth", "tokens", "--all"]);
    expectNoSecrets(text.out);
    expect((await run(["mcp", "oauth", "tokens", "--client", `sbc_${"Z".repeat(22)}`])).code).toBe(1);
  });

  it("revokes a client and its tokens, or with --tokens-only only its tokens, audited", async () => {
    const tokensOnly = await run(["mcp", "oauth", "revoke", clientId, "--tokens-only", "--json"]);
    expect(tokensOnly.code).toBe(0);
    expect(JSON.parse(tokensOnly.out)).toMatchObject({
      client_id: clientId,
      status: "approved",
      client_revoked: false,
      tokens_revoked: 3,
    });
    withDb((db) => {
      const tokens = new OAuthTokenStore(db, { now: () => NOW });
      expect(tokens.verify(raw[0] as string, "access", RESOURCE)).toEqual({ ok: false, reason: "revoked" });
    });
    const full = await run(["mcp", "oauth", "revoke", clientId]);
    expect(full.code).toBe(0);
    expect(full.out).toContain("client revoked (was approved), 0 token(s) revoked");
    withDb((db) => {
      expect(new OAuthClientStore(db).get(clientId)?.status).toBe("revoked");
      expect(
        new OAuthAuditLog(db)
          .list(clientId)
          .map((e) => [e.kind, e.actor, e.reason])
          .filter(([k]) => k !== "consent_approved"),
      ).toEqual([
        ["tokens_revoked", "cli:operator", "tokens_3"],
        ["client_revoked", "cli:operator", "tokens_0"],
      ]);
    });
    expect((await run(["mcp", "oauth", "revoke", `sbc_${"Z".repeat(22)}`])).code).toBe(1);
  });

  it("refuses misplaced options and unknown subcommands", async () => {
    for (const args of [
      ["mcp", "oauth", "clients", "--tokens-only"],
      ["mcp", "oauth", "tokens", "--client-profile", "grok-bot"],
      ["mcp", "oauth", "clients", "--ttl", "5m"],
      ["mcp", "oauth", "clients", "--client", "x"],
      ["runs", "list", "--client-profile", "x"],
      ["mcp", "oauth", "nope"],
      ["mcp", "nope"],
      ["mcp", "oauth", "client"],
      ["mcp", "oauth", "revoke"],
      ["mcp", "oauth", "clients", "extra"],
    ]) {
      expect((await run(args)).code, args.join(" ")).toBe(2);
    }
  });
});
