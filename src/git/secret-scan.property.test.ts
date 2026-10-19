/**
 * Generated-input properties for the pre-push secret scanner (FR-GIT-11, NFR-MAINT-06, T8.11; ADR-0061, LLD §20.9).
 *
 * The scanner reads added lines only: every generated canary shape in an added line is found with its rule id, and
 * the same canary in context or removed lines is never reported. A premise test pins each canary to its rule first.
 * Deterministic: fixed seed, fixed run count.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { matchingRuleIds, SECRET_SCAN_RULES, scanDiffText } from "./secret-scan.js";

/** Fixed so a CI failure reproduces locally; bump only with the reason recorded. */
const SEED = 811091;
const NUM_RUNS = 100;

/** One canary per scanned rule id (the secret part; carriers put it on added lines). */
const CANARIES: Readonly<Record<string, string>> = {
  pem_private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
  aws_access_key_id: `AKIA${"Q".repeat(16)}`,
  github_token: `ghp_${"a".repeat(36)}`,
  github_fine_grained_pat: `github_pat_${"b".repeat(22)}`,
  sk_api_key: `sk-ant-${"c".repeat(20)}`,
  slack_token: `xoxb-${"d".repeat(10)}`,
  jwt: `eyJ${"e".repeat(8)}.${"f".repeat(8)}.${"g".repeat(8)}`,
  switchboard_tool_token: `sbt1_${"h".repeat(43)}`,
  switchboard_oauth_token: `sbat_${"i".repeat(43)}`,
  bearer_authorization: `Bearer ${"k".repeat(16)}`,
  credential_assignment: `password=${"l".repeat(12)}`,
};

/** Surrounding words that cannot themselves form a secret (lowercase, no digits, no markers). */
const word = () => fc.constantFrom("fix", "update", "the", "docs", "and", "tests", "note", "value");

const diffWith = (path: string, body: string[]): string =>
  [`diff --git a/${path} b/${path}`, "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", ...body].join("\n");

describe("secret scanner properties (T8.11)", () => {
  it("every canary matches exactly the rule it is built for", () => {
    const ids = new Set(SECRET_SCAN_RULES.map((r) => r.id));
    for (const [id, canary] of Object.entries(CANARIES)) {
      expect(ids.has(id), `rule ${id} is scanned`).toBe(true);
      const firstLine = canary.split("\n")[0] as string;
      expect(matchingRuleIds(firstLine), id).toContain(id);
    }
  });

  it("every generated canary shape in an added line is found with its rule id", () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(CANARIES)), word(), word(), (id, before, after) => {
        const canary = CANARIES[id] as string;
        const added = canary.split("\n").map((line) => `+${before} ${line} ${after}`);
        const report = scanDiffText(diffWith("f.txt", [" context", ...added]));
        expect(report.hitCount, `${id} is found`).toBeGreaterThan(0);
        expect(
          report.hits.map((h) => h.rule_id),
          `${id} reported`,
        ).toContain(id);
        expect(report.hits.every((h) => h.path === "f.txt")).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it("the same canary in context or removed lines is never reported", () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(CANARIES)), word(), (id, fill) => {
        const canary = CANARIES[id] as string;
        const lines = canary.split("\n").flatMap((line) => [` ${fill} ${line}`, `-${line} ${fill}`]);
        const report = scanDiffText(diffWith("f.txt", lines));
        expect(report.hitCount, `${id} in context/removed lines`).toBe(0);
        expect(report.hits).toEqual([]);
      }),
      { numRuns: NUM_RUNS, seed: SEED + 1 },
    );
  });
});
