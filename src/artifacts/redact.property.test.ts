/**
 * Generated-input properties for the artifact secret redactor (FR-TEL-03, NFR-MAINT-06, T8.11; TDD §3.3 layer 3).
 *
 * For every secret rule a generated canary of that rule's shape, embedded in generated surrounding text, must not
 * survive redaction — neither the value rules nor the prefix-preserving rules may leak the secret part. A premise
 * test pins each canary to its rule first, so a failure names the rule, not the generator. Deterministic: fixed seed.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSecretRedactor, defaultRedactor, PREFIXED_RULES, SECRET_RULES } from "./redact.js";

/** Fixed so a CI failure reproduces locally; bump only with the reason recorded. */
const SEED = 811042;
const NUM_RUNS = 100;

/** One canary per rule id: the secret part only (prefixes of the prefixed rules are not secret). */
const CANARIES: Readonly<Record<string, { secret: string; carrier: (secret: string) => string }>> = {
  pem_private_key: {
    secret: "MIIEvwIBADANBgkqhkiG9w0BAQEFAASC",
    carrier: (s) => `-----BEGIN PRIVATE KEY-----\n${s}\n-----END PRIVATE KEY-----`,
  },
  aws_access_key_id: { secret: `AKIA${"Q".repeat(16)}`, carrier: (s) => s },
  github_token: { secret: `ghp_${"a".repeat(36)}`, carrier: (s) => s },
  github_fine_grained_pat: { secret: `github_pat_${"b".repeat(22)}`, carrier: (s) => s },
  sk_api_key: { secret: `sk-ant-${"c".repeat(20)}`, carrier: (s) => s },
  slack_token: { secret: `xoxb-${"d".repeat(10)}`, carrier: (s) => s },
  jwt: { secret: `eyJ${"e".repeat(8)}.${"f".repeat(8)}.${"g".repeat(8)}`, carrier: (s) => s },
  switchboard_tool_token: { secret: `sbt1_${"h".repeat(43)}`, carrier: (s) => s },
  switchboard_oauth_token: { secret: `sbat_${"i".repeat(43)}`, carrier: (s) => s },
  bearer_authorization: { secret: "k".repeat(16), carrier: (s) => `Bearer ${s}` },
  credential_assignment: { secret: "l".repeat(12), carrier: (s) => `password=${s}` },
};

/** Surrounding text in an alphabet that cannot itself form a secret (lowercase words, spaces, newlines). */
const surrounding = () =>
  fc
    .array(fc.constantFrom("fix", "update", "the", "parser", "redact", "output", "log", "line"), {
      minLength: 1,
      maxLength: 10,
    })
    .map((words) => words.join(" "));

describe("redactor properties (T8.11)", () => {
  it("every canary matches the rule it is built for", () => {
    const byId = new Map([...SECRET_RULES, ...PREFIXED_RULES].map((r) => [r.id, r]));
    for (const [id, { carrier, secret }] of Object.entries(CANARIES)) {
      const rule = byId.get(id);
      expect(rule, `rule ${id} exists`).toBeDefined();
      const text = carrier(secret);
      expect(new RegExp(rule?.pattern.source ?? "(?!)", rule?.pattern.flags).test(text), id).toBe(true);
      expect(defaultRedactor(Buffer.from(text, "utf8")).toString("utf8"), `${id} is redacted at all`).not.toContain(
        secret,
      );
    }
  });

  it("no generated canary survives redaction, whatever surrounds it", () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(CANARIES)), surrounding(), surrounding(), (id, before, after) => {
        const { carrier, secret } = CANARIES[id] as { carrier: (s: string) => string; secret: string };
        const text = `${before} ${carrier(secret)} ${after}`;
        const out = defaultRedactor(Buffer.from(text, "utf8")).toString("utf8");
        expect(out, `${id} in ${JSON.stringify(text)}`).not.toContain(secret);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it("extra patterns redact too, and the default set still applies", () => {
    const redactor = createSecretRedactor([/\bcanary-\d{6}\b/g]);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999999 }), surrounding(), (n, context) => {
        const token = `canary-${String(n).padStart(6, "0")}`;
        const text = `${context} ${token} ghp_${"z".repeat(36)}`;
        const out = redactor(Buffer.from(text, "utf8")).toString("utf8");
        expect(out, text).not.toContain(token);
        expect(out, text).not.toContain(`ghp_${"z".repeat(36)}`);
      }),
      { numRuns: NUM_RUNS, seed: SEED + 1 },
    );
  });
});
