/**
 * ADR-0069: the `publish_run` pull-request argv (G13 `pr create`, G14 `pr view --json number,state,url`), its audit and
 * parsers, and {@link GhPullRequestPort} over a fake {@link GhRunner}. ADR-0078: G16 `pr close` for MCP `close_pr`.
 * ADR-0095: the `GH_FAILED` detail classified from stderr. No real `gh` runs (a fake `gh` script does).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  G14_FIELDS,
  G17_FIELDS,
  ghPrCloseArgv,
  ghPrCreateArgv,
  ghPrLinkViewArgv,
  ghPrNumberViewArgv,
  isAllowedGhArgv,
  isPrBody,
  isPrTitle,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX,
  parsePrCreated,
  parsePrLinkView,
  parsePrNumberView,
  pullRequestNumberOf,
} from "./gh-argv.js";
import { execGh, type GhRunner, type GhRunResult } from "./gh-port.js";
import { GH_FAILURE_MESSAGE_MAX, GhPullRequestPort, ghFailureDetail, PullRequestPortError } from "./gh-pr.js";

const URL1 = "https://github.com/acme/web/pull/7";

describe("G13 and G14 gh argv (ADR-0069)", () => {
  it("builds both templates, one value per cell, and the audit accepts exactly them", () => {
    const create = ghPrCreateArgv("acme", "web", "sb/sess_1", "main", "switchboard: Fix it", "body\nline", false);
    expect(create).toEqual([
      "pr",
      "create",
      "--repo",
      "acme/web",
      "--head",
      "sb/sess_1",
      "--base",
      "main",
      "--title",
      "switchboard: Fix it",
      "--body",
      "body\nline",
    ]);
    expect(ghPrCreateArgv("acme", "web", "sb/x", "main", "t", "b", true).at(-1)).toBe("--draft");
    expect(ghPrLinkViewArgv("acme", "web", "sb/sess_1")).toEqual([
      "pr",
      "view",
      "sb/sess_1",
      "--repo",
      "acme/web",
      "--json",
      G14_FIELDS,
    ]);
    expect(isAllowedGhArgv(create)).toBe(true);
  });

  it("the audit refuses every drift: extra flags, flag-like or control-character cells, bad names", () => {
    const ok = ghPrCreateArgv("acme", "web", "sb/x", "main", "t", "b", false);
    expect(isAllowedGhArgv([...ok, "--web"])).toBe(false);
    expect(isAllowedGhArgv([...ok, "--draft", "--draft"])).toBe(false);
    expect(isAllowedGhArgv(ok.map((c) => (c === "t" ? "--fill" : c)))).toBe(false);
    expect(isAllowedGhArgv(ok.map((c) => (c === "--title" ? "--label" : c)))).toBe(false);
    expect(isAllowedGhArgv(ok.map((c) => (c === "main" ? "-main" : c)))).toBe(false);
    expect(isAllowedGhArgv(["pr", "view", "sb/x", "--repo", "acme/web", "--json", "number,state,url,body"])).toBe(
      false,
    );
    expect(() => ghPrCreateArgv("acme", "web", "sb/x", "main", "a\u0007b", "b", false)).toThrow(/title/u);
    expect(() => ghPrCreateArgv("acme", "web", "sb/x", "main", "t", "-b", false)).toThrow(/body/u);
    expect(() => ghPrCreateArgv("acme", "web", "sb/x", "main", "t", "a\u0000b", false)).toThrow(/body/u);
    expect(() => ghPrCreateArgv("acme", "web", "../x", "main", "t", "b", false)).toThrow(/branch/u);
    expect(() => ghPrCreateArgv("ac me", "web", "sb/x", "main", "t", "b", false)).toThrow(/owner/u);
    expect(isPrTitle("x".repeat(PR_TITLE_MAX))).toBe(true);
    expect(isPrTitle("x".repeat(PR_TITLE_MAX + 1))).toBe(false);
    expect(isPrTitle("one\ntwo")).toBe(false);
    expect(isPrBody("tab\tand\r\nlines")).toBe(true);
    expect(isPrBody("x".repeat(PR_BODY_MAX_BYTES + 1))).toBe(false);
  });

  it("parses only a URL of the expected repository, and only the allowlisted view fields", () => {
    expect(pullRequestNumberOf(URL1, "acme", "web")).toBe(7);
    expect(pullRequestNumberOf("https://github.com/ACME/Web/pull/7", "acme", "web")).toBe(7);
    expect(pullRequestNumberOf("https://github.com/other/web/pull/7", "acme", "web")).toBeUndefined();
    expect(pullRequestNumberOf("https://evil.example/acme/web/pull/7", "acme", "web")).toBeUndefined();
    expect(pullRequestNumberOf(`${URL1}/files`, "acme", "web")).toBeUndefined();
    expect(parsePrCreated(`Creating pull request\n${URL1}\n`, "acme", "web")).toEqual({ number: 7, url: URL1 });
    expect(() => parsePrCreated("something else", "acme", "web")).toThrow();
    expect(parsePrLinkView(JSON.stringify({ number: 7, state: "OPEN", url: URL1, title: "x" }), "acme", "web")).toEqual(
      {
        number: 7,
        state: "OPEN",
        url: URL1,
      },
    );
    expect(() => parsePrLinkView(JSON.stringify({ number: 8, state: "OPEN", url: URL1 }), "acme", "web")).toThrow();
    expect(() => parsePrLinkView(JSON.stringify({ number: 7, state: "open; rm", url: URL1 }), "acme", "web")).toThrow();
  });
});

describe("G16 gh argv (ADR-0078)", () => {
  it("builds the close template with a controller comment, --delete-branch only when asked, and audits it", () => {
    const close = ghPrCloseArgv("acme", "web", "7", "Superseded by #9.", false);
    expect(close).toEqual(["pr", "close", "7", "--repo", "acme/web", "--comment", "Superseded by #9."]);
    expect(ghPrCloseArgv("acme", "web", "7", "c", true).at(-1)).toBe("--delete-branch");
    expect(isAllowedGhArgv(close)).toBe(true);
    expect(isAllowedGhArgv([...close, "--delete-branch"])).toBe(true);
  });

  it("the audit refuses drift: other flags, a branch or URL instead of a number, a flag-like comment", () => {
    const ok = ghPrCloseArgv("acme", "web", "7", "c", false);
    expect(isAllowedGhArgv([...ok, "--delete-branch", "--delete-branch"])).toBe(false);
    expect(isAllowedGhArgv([...ok, "--admin"])).toBe(false);
    expect(isAllowedGhArgv(ok.map((c) => (c === "7" ? "sb/x" : c)))).toBe(false);
    expect(isAllowedGhArgv(ok.map((c) => (c === "7" ? URL1 : c)))).toBe(false);
    expect(isAllowedGhArgv(ok.map((c) => (c === "--comment" ? "--body" : c)))).toBe(false);
    expect(() => ghPrCloseArgv("acme", "web", "7", "-c", false)).toThrow(/comment/u);
    expect(() => ghPrCloseArgv("acme", "web", "0", "c", false)).toThrow(/number/u);
    expect(() => ghPrCloseArgv("ac me", "web", "7", "c", false)).toThrow(/owner/u);
  });

  it("G17 reads one pull request by number only, and parses only a safe head branch", () => {
    const view = ghPrNumberViewArgv("acme", "web", "7");
    expect(view).toEqual(["pr", "view", "7", "--repo", "acme/web", "--json", G17_FIELDS]);
    expect(isAllowedGhArgv(view)).toBe(true);
    expect(isAllowedGhArgv(["pr", "view", "sb/x", "--repo", "acme/web", "--json", G17_FIELDS])).toBe(false);
    expect(() => ghPrNumberViewArgv("acme", "web", "x")).toThrow(/number/u);
    const out = JSON.stringify({ number: 7, state: "OPEN", url: URL1, headRefName: "sb/x", body: "ignored" });
    expect(parsePrNumberView(out, "acme", "web")).toEqual({ number: 7, state: "OPEN", url: URL1, headRefName: "sb/x" });
    const bad = JSON.stringify({ number: 7, state: "OPEN", url: URL1, headRefName: "-x" });
    expect(() => parsePrNumberView(bad, "acme", "web")).toThrow();
  });
});

describe("GhPullRequestPort (ADR-0069)", () => {
  const fake = (results: GhRunResult[]) => {
    const calls: { argv: readonly string[]; env: Record<string, string> }[] = [];
    const runner: GhRunner = async (_bin, argv, opts) => {
      calls.push({ argv, env: opts.env });
      const r = results.shift();
      if (r === undefined) throw new Error("unexpected gh call");
      return r;
    };
    return { calls, runner };
  };
  const SECRET_ENV = { PATH: "/usr/bin", HOME: "/home/op", GH_TOKEN: "ghp_secret", GITHUB_TOKEN: "ghp_secret2" };

  it("finds an open pull request, reads exit 1 as none, and creates one; never passes a token variable", async () => {
    const { calls, runner } = fake([
      { exitCode: 0, stdout: JSON.stringify({ number: 7, state: "OPEN", url: URL1 }) },
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: `${URL1}\n` },
    ]);
    const port = new GhPullRequestPort({ runner, sourceEnv: SECRET_ENV });
    expect(await port.findForBranch({ owner: "acme", repo: "web", branch: "sb/x" })).toEqual({
      number: 7,
      state: "OPEN",
      url: URL1,
    });
    expect(await port.findForBranch({ owner: "acme", repo: "web", branch: "sb/x" })).toBeNull();
    const created = await port.create({
      owner: "acme",
      repo: "web",
      branch: "sb/x",
      base: "main",
      title: "switchboard: x",
      body: "b",
      draft: true,
    });
    expect(created).toEqual({ number: 7, url: URL1 });
    for (const c of calls) {
      expect(isAllowedGhArgv(c.argv)).toBe(true);
      expect(Object.keys(c.env)).not.toContain("GH_TOKEN");
      expect(Object.keys(c.env)).not.toContain("GITHUB_TOKEN");
      expect(c.env.GH_PROMPT_DISABLED).toBe("1");
    }
  });

  it.each([
    [{ exitCode: null, stdout: "", notFound: true }, "GH_MISSING"],
    [{ exitCode: null, stdout: "", timedOut: true }, "TIMEOUT"],
    [{ exitCode: 4, stdout: "" }, "AUTH_REQUIRED"],
    [{ exitCode: 2, stdout: "" }, "GH_FAILED"],
    [{ exitCode: 0, stdout: "https://github.com/other/web/pull/1" }, "PARSE_FAILED"],
  ] as const)("create failure %j is the closed code %s", async (result, code) => {
    const { runner } = fake([{ ...result }]);
    const port = new GhPullRequestPort({ runner });
    const err = await port
      .create({ owner: "acme", repo: "web", branch: "sb/x", base: "main", title: "t", body: "b", draft: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRequestPortError);
    expect((err as PullRequestPortError).code).toBe(code);
  });

  it("ADR-0078: findByNumber runs G17 (exit 1 is none); close runs G16 and maps failures to the closed codes", async () => {
    const view = fake([
      { exitCode: 0, stdout: JSON.stringify({ number: 7, state: "CLOSED", url: URL1, headRefName: "sb/x" }) },
      { exitCode: 1, stdout: "" },
    ]);
    const reader = new GhPullRequestPort({ runner: view.runner });
    expect(await reader.findByNumber({ owner: "acme", repo: "web", number: 7 })).toEqual({
      number: 7,
      state: "CLOSED",
      url: URL1,
      headBranch: "sb/x",
    });
    expect(await reader.findByNumber({ owner: "acme", repo: "web", number: 7 })).toBeNull();
    expect(isAllowedGhArgv(view.calls[0]?.argv ?? [])).toBe(true);
    const { calls, runner } = fake([
      { exitCode: 0, stdout: "" },
      { exitCode: 1, stdout: "" },
    ]);
    const port = new GhPullRequestPort({ runner, sourceEnv: SECRET_ENV });
    await port.close({ owner: "acme", repo: "web", number: 7, comment: "Superseded by #9.", deleteBranch: true });
    expect(calls[0]?.argv).toEqual([
      "pr",
      "close",
      "7",
      "--repo",
      "acme/web",
      "--comment",
      "Superseded by #9.",
      "--delete-branch",
    ]);
    expect(Object.keys(calls[0]?.env ?? {})).not.toContain("GH_TOKEN");
    const err = await port
      .close({ owner: "acme", repo: "web", number: 7, comment: "c", deleteBranch: false })
      .catch((e: unknown) => e);
    expect((err as PullRequestPortError).code).toBe("GH_FAILED");
  });
  it.each([
    [
      "GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and sb/x, Head ref must be a branch (createPullRequest)",
      "HEAD_BRANCH_MISSING",
    ],
    ["GraphQL: Base ref must be a branch (createPullRequest)", "BASE_BRANCH_MISSING"],
    ["GraphQL: No commits between main and sb/x (createPullRequest)", "NO_COMMITS"],
    ['a pull request for branch "sb/x" into branch "main" already exists:', "PULL_REQUEST_EXISTS"],
    ["API rate limit exceeded for user ID 1. (HTTP 403)", "RATE_LIMITED"],
    ["GraphQL: Resource not accessible by integration (createPullRequest)", "PERMISSION_DENIED"],
    ["GraphQL: Could not resolve to a Repository with the name 'acme/web'. (repository)", "NOT_FOUND"],
    ["error connecting to api.github.com: dial tcp: i/o timeout", "NETWORK"],
    ["HTTP 422: Validation Failed", "VALIDATION_FAILED"],
    ["something else", "UNKNOWN"],
    ["", "UNKNOWN"],
  ] as const)("ADR-0095: stderr %j is the closed reason %s", (stderr, reason) => {
    expect(ghFailureDetail(1, stderr).reason).toBe(reason);
  });

  it("ADR-0095: the excerpt redacts secrets, drops control characters, joins lines and is capped", () => {
    const token = `ghp_${"b".repeat(36)}`;
    const d = ghFailureDetail(1, `line one\u001b[31m\r\n\n Bearer abcdefghijkl ${token}\n${"x".repeat(1000)}`);
    expect(d.exit_code).toBe(1);
    expect(d.message).toMatch(/^line one \[31m \| Bearer \[REDACTED\] \[REDACTED\] \| x+\.\.\.$/u);
    expect(d.message.length).toBe(GH_FAILURE_MESSAGE_MAX);
    expect(d.message).not.toContain(token);
  });

  it("ADR-0095: a non-zero create exit is GH_FAILED with the detail read from stderr", async () => {
    const { runner } = fake([
      {
        exitCode: 1,
        stdout: "",
        stderr: "GraphQL: No commits between main and sb/x",
      },
    ]);
    const err = await new GhPullRequestPort({ runner })
      .create({
        owner: "acme",
        repo: "web",
        branch: "sb/x",
        base: "main",
        title: "t",
        body: "b",
        draft: false,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRequestPortError);
    expect((err as PullRequestPortError).detail).toEqual({
      exit_code: 1,
      reason: "NO_COMMITS",
      message: "GraphQL: No commits between main and sb/x",
    });
  });

  it("ADR-0095: execGh keeps the stderr tail of a failed gh (fake gh script), and none on success", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sb-gh-stderr-"));
    try {
      const bin = path.join(dir, "fake-gh");
      writeFileSync(
        bin,
        [
          "#!/bin/sh",
          'if [ "$1" = "ok" ]; then echo out; exit 0; fi',
          "echo 'Head ref must be a branch' >&2",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );
      const failed = await execGh(bin, ["pr"], {
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
      });
      expect(failed).toMatchObject({
        exitCode: 1,
        stderr: "Head ref must be a branch\n",
      });
      const ok = await execGh(bin, ["ok"], {
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
      });
      expect(ok).toEqual({ exitCode: 0, stdout: "out\n" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
