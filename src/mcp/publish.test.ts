/**
 * `publish_run` refusals of the pre-push secret scan (ADR-0075, LLD §3.4.12, §20.9): `pushRefusal` over synthetic
 * {@link PushResult}s, then through the MCP error envelope with the server's scrubber. No Git, no provider CLI. The
 * "secret" below is a synthetic canary built at run time; the scanner never hands a value to a refusal, so the test
 * checks that nothing value-shaped can appear even when a caller holds one.
 */
import { describe, expect, it } from "vitest";
import type { PushResult } from "../git/push.js";
import { MAX_SECRET_SCAN_MESSAGE_FINDINGS } from "../git/secret-scan.js";
import { errorEnvelope } from "./errors.js";
import { pushRefusal } from "./publish.js";
import { createScrubber } from "./scrub.js";

const CANARY = `ghp_canary${"0".repeat(30)}`;

function refused(hits: PushResult["secretScan"]): PushResult {
  return {
    pushId: "gps_test",
    outcome: "REFUSED_POLICY",
    reason: "SECRET_SCAN_BLOCKED",
    pushed: false,
    remote: "origin",
    ref: "refs/heads/sb/sess_x",
    headSha: "a".repeat(40),
    commits: [],
    eventRunId: "run_x",
    toolCode: "SECRET_SCAN_BLOCKED",
    ...(hits !== undefined ? { secretScan: hits } : {}),
  };
}

describe("publish_run secret-scan refusal (ADR-0075)", () => {
  it("names each finding in details and in the message, with the exact count and a fix hint; never the value", () => {
    const err = pushRefusal(
      refused({
        hits: [
          { rule_id: "github_token", path: "test/fixtures/a.ts", line: 12 },
          { rule_id: "jwt", path: "src/x.ts", line: 4 },
        ],
        hitCount: 2,
      }),
    );
    expect(err.code).toBe("PERMISSION_BLOCKED");
    expect(err.details).toEqual({
      reason: "SECRET_SCAN_BLOCKED",
      push_id: "gps_test",
      findings: [
        { rule_id: "github_token", path: "test/fixtures/a.ts", line: 12 },
        { rule_id: "jwt", path: "src/x.ts", line: 4 },
      ],
      finding_count: 2,
    });
    expect(err.message).toMatch(
      /^push refused \(SECRET_SCAN_BLOCKED\): 2 secret-scan findings: github_token at test\/fixtures\/a\.ts:12; jwt at src\/x\.ts:4\. /u,
    );
    expect(err.message).toContain("build fake values at run time");
    expect(err.message).toContain("git.secret_scan.allow");
    const env = errorEnvelope(err, createScrubber(["/nonexistent-root"]));
    expect(env.error.details).toEqual(err.details);
    expect(env.error.message).toBe(err.message);
    expect(JSON.stringify(env)).not.toContain(CANARY);
    expect(JSON.stringify(env)).not.toContain("ghp_");
  });

  it("caps the message list, sets findings_truncated when the report kept fewer hits than it counted", () => {
    const hits = Array.from({ length: 100 }, (_, i) => ({ rule_id: "aws_access_key_id", path: `f${i}.txt`, line: i }));
    const err = pushRefusal(refused({ hits, hitCount: 140 }));
    expect(err.details.finding_count).toBe(140);
    expect(err.details.findings_truncated).toBe(true);
    expect(err.details.findings).toHaveLength(100);
    expect(err.message).toContain(`140 secret-scan findings: aws_access_key_id at f0.txt:0;`);
    expect(err.message).toContain(`; and ${140 - MAX_SECRET_SCAN_MESSAGE_FINDINGS} more.`);
    expect(err.message).not.toContain(`f${MAX_SECRET_SCAN_MESSAGE_FINDINGS}.txt`);
    const env = errorEnvelope(err, createScrubber([]));
    // The envelope cuts messages at 2000 characters; the list budget keeps the hint inside it.
    expect(env.error.message.length).toBeLessThan(2000);
    expect(env.error.message).toContain("git.secret_scan.allow");
  });

  it("a path with control or bidirectional characters is JSON-quoted and escaped in the message, never raw", () => {
    const odd = "a\nb\u001b[31m\u202e.ts";
    const err = pushRefusal(refused({ hits: [{ rule_id: "jwt", path: odd, line: 3 }], hitCount: 1 }));
    expect(err.message).toContain(String.raw`jwt at "a\nb\u001b[31m\u202e.ts":3`);
    // Every character of the message is printable ASCII: no line break, escape sequence or bidirectional override.
    expect([...err.message].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e)).toBe(true);
    // The structured field keeps the exact path (JSON escapes it on the wire).
    expect(err.details.findings).toEqual([{ rule_id: "jwt", path: odd, line: 3 }]);
  });

  it("other refusals are unchanged", () => {
    const err = pushRefusal({ ...refused(undefined), reason: "POLICY_NONE", toolCode: "PUSH_NOT_ALLOWED" });
    expect(err.message).toBe("push refused (POLICY_NONE)");
    expect(err.details).toEqual({ reason: "POLICY_NONE", push_id: "gps_test" });
  });
});
