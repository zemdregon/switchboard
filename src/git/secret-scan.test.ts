/**
 * T9.14 (FR-GIT-11, ADR-0061, LLD §20.9): the pre-push secret scanner. Pure diff-text tests plus one real-Git range
 * through the hardened helper. Every canary is a synthetic shape (fake prefix plus filler), never a real credential;
 * a report must never contain a matched value.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREFIXED_RULES, SECRET_RULES } from "../artifacts/redact.js";
import {
  compileSecretScanAllow,
  MAX_SECRET_SCAN_HITS,
  matchingRuleIds,
  outgoingDiffArgs,
  SECRET_SCAN_RULE_IDS,
  SECRET_SCAN_RULES,
  SecretScanAllowError,
  scanDiffText,
  scanOutgoingDiff,
  secretScanBlockedFromPushEvents,
  unquoteC,
} from "./secret-scan.js";

/** One synthetic canary per rule id (fake shapes). */
const CANARIES: Readonly<Record<string, string>> = {
  pem_private_key: "-----BEGIN RSA PRIVATE KEY-----",
  aws_access_key_id: "AKIACANARY0000000000",
  github_token: `ghp_canary${"0".repeat(30)}`,
  github_fine_grained_pat: `github_pat_canary${"0".repeat(20)}`,
  sk_api_key: `sk-canary${"0".repeat(20)}`,
  slack_token: "xoxb-canary-0000000000",
  jwt: "eyJcanary00.canary000.canary000",
  switchboard_tool_token: `sbt1_${"c".repeat(43)}`,
  switchboard_oauth_token: `sbat_${"c".repeat(43)}`,
  bearer_authorization: "Authorization: Bearer canarytoken0001",
  credential_assignment: "password=canaryhunter2",
};

const diffOf = (file: string, lines: readonly string[], start = 1): string =>
  [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +${start},${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");

describe("rule set (reuses the artifact redactor's rules, LLD §20.9)", () => {
  it("is the redactor's value rules then its prefixed rules, every id stable and unique", () => {
    expect(SECRET_SCAN_RULES.map((r) => r.id)).toEqual([...SECRET_RULES, ...PREFIXED_RULES].map((r) => r.id));
    expect(new Set(SECRET_SCAN_RULES.map((r) => r.id)).size).toBe(SECRET_SCAN_RULES.length);
    expect([...SECRET_SCAN_RULE_IDS].sort()).toEqual(Object.keys(CANARIES).sort());
  });

  it("every rule matches its canary and no canary matches an unrelated line", () => {
    for (const [id, canary] of Object.entries(CANARIES)) expect(matchingRuleIds(canary), id).toContain(id);
    expect(matchingRuleIds("const answer = 42; // nothing secret here")).toEqual([]);
    expect(matchingRuleIds("")).toEqual([]);
  });

  it("is deterministic across calls (no global regex state)", () => {
    const line = CANARIES.aws_access_key_id as string;
    expect(matchingRuleIds(line)).toEqual(matchingRuleIds(line));
    expect(matchingRuleIds(`${line} ${line}`)).toEqual(["aws_access_key_id"]);
  });
});

describe("scanDiffText (added lines only; rule id, path and line; never the value)", () => {
  it("reports the rule id, path and new-file line of a hit in an added line", () => {
    const diff = diffOf("src/creds.txt", ["clean", CANARIES.aws_access_key_id as string, "clean"]);
    const r = scanDiffText(diff);
    expect(r).toEqual({
      hits: [{ rule_id: "aws_access_key_id", path: "src/creds.txt", line: 2 }],
      hitCount: 1,
      allowedCount: 0,
    });
    expect(JSON.stringify(r)).not.toContain("CANARY0000");
  });

  it("ignores removed lines, context lines and headers; counts lines per hunk", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "index 1111111..2222222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -3,1 +3,0 @@",
      `-${CANARIES.slack_token}`,
      "@@ -10,0 +10,2 @@",
      "+ok",
      `+${CANARIES.github_token}`,
      "@@ -20,2 +21,3 @@",
      " context",
      `+${CANARIES.sk_api_key}`,
      " context",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(scanDiffText(diff).hits).toEqual([
      { rule_id: "github_token", path: "f.txt", line: 11 },
      { rule_id: "sk_api_key", path: "f.txt", line: 22 },
    ]);
  });

  it("an added content line that looks like a header or a file boundary is still content", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -0,0 +1,3 @@",
      "+++ b/other.txt", // added content `++ b/other.txt`
      `+${CANARIES.jwt}`,
      "+-- a/x",
      "",
    ].join("\n");
    expect(scanDiffText(diff).hits).toEqual([{ rule_id: "jwt", path: "f.txt", line: 2 }]);
  });

  it("scans every file of a multi-file diff and reports hits in diff order", () => {
    const diff =
      diffOf("a.txt", [CANARIES.pem_private_key as string]) + diffOf("b/c.txt", ["x", CANARIES.jwt as string]);
    expect(scanDiffText(diff).hits).toEqual([
      { rule_id: "pem_private_key", path: "a.txt", line: 1 },
      { rule_id: "jwt", path: "b/c.txt", line: 2 },
    ]);
  });

  it("undoes Git's C-style quoting of a path", () => {
    const diff = diffOf("x", ["ignored"]).replace("+++ b/x", '+++ "b/sp ace\\ttab\\"q\\303\\251.txt"');
    const r = scanDiffText(diff.replace("+ignored", `+${CANARIES.slack_token}`));
    expect(r.hits).toEqual([{ rule_id: "slack_token", path: 'sp ace\ttab"qé.txt', line: 1 }]);
    expect(unquoteC('"a\\\\b"')).toBe("a\\b");
  });

  it("the allowlist suppresses a hit by rule id and exact path glob, and counts it", () => {
    const allow = compileSecretScanAllow([{ rule_id: "aws_access_key_id", path: "fixtures/**" }]);
    const inside = diffOf("fixtures/sample.txt", [CANARIES.aws_access_key_id as string]);
    expect(scanDiffText(inside, allow)).toEqual({ hits: [], hitCount: 0, allowedCount: 1 });
    const outside = diffOf("src/sample.txt", [CANARIES.aws_access_key_id as string]);
    expect(scanDiffText(outside, allow).hitCount).toBe(1);
    const otherRule = diffOf("fixtures/sample.txt", [CANARIES.slack_token as string]);
    expect(scanDiffText(otherRule, allow).hitCount).toBe(1);
    // A glob is not a directory prefix: `fixtures` alone does not cover `fixtures/sample.txt`.
    const bare = compileSecretScanAllow([{ rule_id: "aws_access_key_id", path: "fixtures" }]);
    expect(scanDiffText(inside, bare).hitCount).toBe(1);
  });

  it("an allowlist entry with an unknown rule id or an empty glob is a configuration error", () => {
    expect(() => compileSecretScanAllow([{ rule_id: "nope", path: "**" }])).toThrow(SecretScanAllowError);
    expect(() => compileSecretScanAllow([{ rule_id: "nope", path: "**" }])).toThrow(/\[0\]\.rule_id: unknown rule/u);
    expect(() => compileSecretScanAllow([{ rule_id: "jwt", path: " " }])).toThrow(/\[0\]\.path/u);
    expect(compileSecretScanAllow([])("jwt", "x")).toBe(false);
  });

  it("lists at most MAX_SECRET_SCAN_HITS hits but counts every one", () => {
    const lines = Array.from({ length: MAX_SECRET_SCAN_HITS + 5 }, () => CANARIES.slack_token as string);
    const r = scanDiffText(diffOf("many.txt", lines));
    expect(r.hits).toHaveLength(MAX_SECRET_SCAN_HITS);
    expect(r.hitCount).toBe(MAX_SECRET_SCAN_HITS + 5);
  });

  it("an empty diff is clean", () => {
    expect(scanDiffText("")).toEqual({ hits: [], hitCount: 0, allowedCount: 0 });
  });
});

describe("secretScanBlockedFromPushEvents (FR-CTL-03 secret_scan_blocked)", () => {
  it("the newest decisive event wins: a block holds through other refusals until an accepted push", () => {
    const blocked = { outcome: "REFUSED_POLICY", reason: "SECRET_SCAN_BLOCKED" };
    const other = { outcome: "REFUSED_POLICY", reason: "POLICY_NONE" };
    const accepted = { outcome: "ACCEPTED", reason: "ACCEPTED" };
    expect(secretScanBlockedFromPushEvents([])).toBe(false);
    expect(secretScanBlockedFromPushEvents([blocked])).toBe(true);
    expect(secretScanBlockedFromPushEvents([other, blocked])).toBe(true);
    expect(secretScanBlockedFromPushEvents([accepted, blocked])).toBe(false);
    expect(secretScanBlockedFromPushEvents([blocked, accepted])).toBe(true);
    expect(secretScanBlockedFromPushEvents([null, "x", other])).toBe(false);
  });
});

describe("scanOutgoingDiff over a real repository (hardened helper, LLD §20.9 scope)", () => {
  const ENV = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.test",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.test",
  };
  let root: string;
  let repo: string;
  const g = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env: ENV, encoding: "utf8" }).trim();

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-secret-scan-")));
    repo = path.join(root, "repo");
    mkdirSync(repo);
    g("init", "-q", "-b", "main");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function commitAll(message: string): string {
    g("add", "-A");
    g("commit", "-q", "-m", message);
    return g("rev-parse", "HEAD");
  }

  it("scans only the range: a canary already in the base tree is not a hit; added lines are; binaries are listed", async () => {
    writeFileSync(path.join(repo, "old.txt"), `${CANARIES.aws_access_key_id}\n`);
    const base = commitAll("base with an old canary");
    writeFileSync(path.join(repo, "clean.txt"), "nothing here\n");
    const clean = commitAll("clean");
    expect(await scanOutgoingDiff(repo, base, clean)).toEqual({
      hits: [],
      hitCount: 0,
      allowedCount: 0,
      binaryPaths: [],
      binaryCount: 0,
    });

    mkdirSync(path.join(repo, "sub dir"));
    writeFileSync(path.join(repo, "sub dir", "new.txt"), `line one\n${CANARIES.github_token}\n`);
    writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0xff, 0]));
    const head = commitAll("adds a canary and a binary");
    const r = await scanOutgoingDiff(repo, base, head);
    expect(r.hits).toEqual([{ rule_id: "github_token", path: "sub dir/new.txt", line: 2 }]);
    expect(r.hitCount).toBe(1);
    expect(r.binaryPaths).toEqual(["blob.bin"]);
    expect(r.binaryCount).toBe(1);
    expect(JSON.stringify(r)).not.toContain("ghp_");
    // The range is a diff of trees: a hit that a later commit removes before the push is not outgoing.
    rmSync(path.join(repo, "sub dir"), { recursive: true });
    const removed = commitAll("removes it again");
    expect((await scanOutgoingDiff(repo, base, removed)).hitCount).toBe(0);
    expect((await scanOutgoingDiff(repo, clean, head)).hitCount).toBe(1);
  });

  it("a `.gitattributes` marking a file binary does not hide its added lines", async () => {
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    const base = commitAll("base");
    writeFileSync(path.join(repo, ".gitattributes"), "*.txt binary\n");
    writeFileSync(path.join(repo, "hidden.txt"), `${CANARIES.slack_token}\n`);
    const head = commitAll("tries to hide a token");
    const r = await scanOutgoingDiff(repo, base, head);
    expect(r.hits).toEqual([{ rule_id: "slack_token", path: "hidden.txt", line: 1 }]);
    expect(r.binaryPaths).toEqual(["hidden.txt"]);
  });

  it("diff arguments pin the shape the parser reads", () => {
    const args = outgoingDiffArgs("a".repeat(40), "b".repeat(40));
    expect(args[0]).toBe("diff");
    for (const flag of ["-U0", "--text", "--no-renames", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"]) {
      expect(args).toContain(flag);
    }
    expect(args.slice(-2)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });
});
