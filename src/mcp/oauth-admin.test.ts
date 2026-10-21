/**
 * `list_oauth_clients` (stdio only): the operator's MCP view of the OAuth clients, the same non-secret data as `switchboard
 * mcp oauth clients|client`. A server built for an HTTP subject never lists or serves it, even when given the view.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedMcpClient } from "../config/index.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import { OAuthAdmin } from "./oauth-admin.js";
import { OAuthClientStore } from "./oauth-clients.js";
import { OAuthTokenStore } from "./oauth-tokens.js";

const RESOURCE = "https://sb.example.test/mcp";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("list_oauth_clients", () => {
  it("returns every client, or one, with profile source and token counts but no token or hash", async () => {
    let clientId = "";
    let raw = "";
    h = await startHarness({
      config: {
        mcpClients: new Map<string, ResolvedMcpClient>([
          ["orch", { id: "orch", maxTrustProfile: "edit-untrusted" }],
          ["other", { id: "other", maxTrustProfile: "edit-untrusted", toolProfile: "console" }],
        ]),
      },
      // Called once per harness client; the fixture is created once.
      deps: ({ db }) => {
        if (clientId === "") {
          const clients = new OAuthClientStore(db);
          const r = clients.register({ redirectUris: ["https://app.example/cb"], grantTypes: ["authorization_code"] });
          if (!r.ok) throw new Error("register");
          clientId = r.client.clientId;
          clients.approveAndBind(clientId, "orch");
          raw = new OAuthTokenStore(db).issue({
            kind: "access",
            clientId,
            resource: RESOURCE,
            scopes: ["mcp"],
            ttlMs: 60_000,
          }).token;
        }
        return {
          oauthAdmin: new OAuthAdmin(db, {
            clientMap: new Map(),
            defaultMcpClient: "other",
            bindableMcpClients: new Set(["orch", "other"]),
          }),
        };
      },
    });
    const all = (await h.ok("list_oauth_clients", {})) as { clients: Record<string, unknown>[] };
    expect(all.clients).toHaveLength(1);
    expect(all.clients[0]).toMatchObject({
      client_id: clientId,
      status: "approved",
      mcp_client: "orch",
      mcp_client_source: "ledger_binding",
      mcp_client_eligible: true,
      tokens: { active: 1, expired: 0, revoked: 0 },
    });
    const text = JSON.stringify(all);
    expect(text).not.toContain(raw);
    expect(text).not.toContain(createHash("sha256").update(raw).digest("hex"));
    const one = (await h.ok("list_oauth_clients", { client_id: clientId })) as { clients: unknown[] };
    expect(one.clients).toHaveLength(1);
    const unknown = await h.call("list_oauth_clients", { client_id: `sbc_${"Z".repeat(22)}` });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.body)).toContain("INVALID_REQUEST");
    const bad = await h.call("list_oauth_clients", { client_id: "nope" });
    expect(bad.isError).toBe(true);
    // A console client's profile does not offer it.
    const consoleCall = await h.call("list_oauth_clients", {}, "other");
    expect(JSON.stringify(consoleCall.body)).toContain("unknown tool");
  });

  it("is absent without the admin view", async () => {
    h = await startHarness();
    const { tools } = await h.client().listTools();
    expect(tools.map((t) => t.name)).not.toContain("list_oauth_clients");
    const r = await h.call("list_oauth_clients", {});
    expect(JSON.stringify(r.body)).toContain("unknown tool");
  });
});
