/**
 * ADR-0069: the `publish_run` pull-request argv (G13 `pr create`, G14 `pr view --json number,state,url`), its audit and
 * parsers, and {@link GhPullRequestPort} over a fake {@link GhRunner}. No real `gh` runs.
 */
import { describe, expect, it } from "vitest";
import {
  G14_FIELDS,
  ghPrCreateArgv,
  ghPrLinkViewArgv,
  isAllowedGhArgv,
  isPrBody,
  isPrTitle,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX,
  parsePrCreated,
  parsePrLinkView,
  pullRequestNumberOf,
} from "./gh-argv.js";
import type { GhRunner, GhRunResult } from "./gh-port.js";
import { GhPullRequestPort, PullRequestPortError } from "./gh-pr.js";

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
});
