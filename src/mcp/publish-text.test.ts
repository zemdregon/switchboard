/**
 * The run's proposed pull request text (ADR-0069 note 2026-10-20, LLD §3.4.12): {@link extractProposal} reads a title
 * and description from a run's result summary only in the two decided shapes, and the title and body builders
 * sanitise agent text (control characters, wrapping markers, trailing period, mentions, caps) and keep the controller
 * footer underneath.
 */
import { describe, expect, it } from "vitest";
import { PR_BODY_MAX_BYTES } from "../ci/gh-argv.js";
import {
  AGENT_TEXT_LABEL,
  DRAFT_BODY_MAX_BYTES,
  extractProposal,
  neutraliseMentions,
  pullRequestBody,
  pullRequestTitle,
  TITLE_TEXT_MAX,
} from "./publish.js";

const RUN = { id: "run_1", meta_session_id: "ms_1", provider: "fake", model: null, project_id: "web" };
const HEAD = { head_sha: "a".repeat(40) };

/** The shape of run_01M5CTYH886F9ZCRA806CZY1T9's summary: chatty preamble, `---`, `## title`, the description. */
const EXAMPLE = [
  "All done! I fixed the broken links. Here is a PR title and description you can use:",
  "",
  "---",
  "",
  "## Fix broken relative Markdown links and anchors (docs only)",
  "",
  "This fixes relative links that pointed at moved files.",
  "",
  "### Changes",
  "",
  "| File | Fix |",
  "| --- | --- |",
  "| docs/a.md | anchor |",
].join("\n");

describe("extractProposal", () => {
  it("takes the heading after a thematic break as the title and the rest as the body", () => {
    expect(extractProposal(EXAMPLE)).toEqual({
      title: "Fix broken relative Markdown links and anchors (docs only)",
      body: [
        "This fixes relative links that pointed at moved files.",
        "",
        "### Changes",
        "",
        "| File | Fix |",
        "| --- | --- |",
        "| docs/a.md | anchor |",
      ].join("\n"),
    });
  });

  it("accepts *** and ___ breaks, a level 1 heading, and CRLF line ends", () => {
    expect(extractProposal("Preamble.\r\n***\r\n# Title one\r\nBody.")).toEqual({ title: "Title one", body: "Body." });
    expect(extractProposal("Preamble.\n\n___\n\n\n## Title two ##\n\nBody.")).toEqual({
      title: "Title two",
      body: "Body.",
    });
  });

  it("takes a level 1/2 heading on the first non-blank line", () => {
    expect(extractProposal("\n\n# Add the feature\n\nIt adds the feature.\n")).toEqual({
      title: "Add the feature",
      body: "It adds the feature.",
    });
    expect(extractProposal("## Only a title")).toEqual({ title: "Only a title", body: "" });
  });

  it("proposes nothing for free prose, a level 3 first heading, or an empty heading", () => {
    expect(extractProposal("I changed three files and the tests pass.")).toBeUndefined();
    expect(extractProposal("### Changes\n\nStuff.")).toBeUndefined();
    expect(extractProposal("#\n\nStuff.")).toBeUndefined();
    expect(extractProposal("#NoSpace is a hashtag")).toBeUndefined();
    expect(extractProposal("")).toBeUndefined();
  });

  it("does not take a heading in the middle of prose unless a break precedes it", () => {
    expect(extractProposal("I did the work.\n\n## Summary\n\nDetails.")).toBeUndefined();
    expect(extractProposal("I did the work.\n---\nMore prose.\n## Summary\nDetails.")).toBeUndefined();
  });

  it("ignores breaks and headings inside fenced code blocks", () => {
    const fenced = "Here is the config:\n\n```yaml\n---\n# a comment\nkey: 1\n```\n\nDone.";
    expect(extractProposal(fenced)).toBeUndefined();
    expect(extractProposal(`${fenced}\n\n---\n\n## Real title\n\nBody.`)).toEqual({
      title: "Real title",
      body: "Body.",
    });
  });
});

describe("pullRequestTitle", () => {
  it("removes control characters, wrapping emphasis or code, and a trailing period", () => {
    expect(pullRequestTitle("**Fix\u0007 the\tlinks.**", "run_1")).toBe("switchboard: Fix the links");
    expect(pullRequestTitle("`fix_links`", "run_1")).toBe("switchboard: fix_links");
    expect(pullRequestTitle("_Fix links_.", "run_1")).toBe("switchboard: Fix links");
    expect(pullRequestTitle("`a` and `b`", "run_1")).toBe("switchboard: `a` and `b`");
    expect(pullRequestTitle("Wait...", "run_1")).toBe("switchboard: Wait...");
  });

  it("caps the run's text, neutralises mentions, and falls back to the run id", () => {
    expect(pullRequestTitle("x".repeat(500), "run_1")).toBe(`switchboard: ${"x".repeat(TITLE_TEXT_MAX)}`);
    expect(pullRequestTitle("Ping @octocat", "run_1")).toBe("switchboard: Ping ＠octocat");
    expect(pullRequestTitle("** **", "run_1")).toBe("switchboard: run_1");
    expect(pullRequestTitle(undefined, "run_1")).toBe("switchboard: run_1");
  });
});

describe("neutraliseMentions", () => {
  it("rewrites @ before a user or team name, not inside an email address", () => {
    expect(neutraliseMentions("cc @octocat and @acme/team; mail a@b.example; @ alone")).toBe(
      "cc ＠octocat and ＠acme/team; mail a@b.example; @ alone",
    );
  });
});

describe("pullRequestBody", () => {
  it("puts the description first, then a break, the source label and the footer", () => {
    const body = pullRequestBody(RUN, HEAD, { body: "Fixes links.\u0000 Thanks @octocat", source: "run_summary" });
    expect(body).toBe(
      [
        "Fixes links. Thanks ＠octocat",
        "",
        "---",
        "",
        AGENT_TEXT_LABEL.run_summary,
        "",
        "Opened by Switchboard `publish_run` with the operator's GitHub login.",
        "",
        "- Run: `run_1`",
        "- Meta-session: `ms_1`",
        "- Provider: fake",
        "- Project: `web`",
        `- Head: \`${"a".repeat(40)}\``,
      ].join("\n"),
    );
  });

  it("is the footer alone with no proposal or an empty description", () => {
    const footerOnly = pullRequestBody(RUN, HEAD, undefined);
    expect(footerOnly.startsWith("Opened by Switchboard")).toBe(true);
    expect(pullRequestBody(RUN, HEAD, { body: "  \n ", source: "pr_draft" })).toBe(footerOnly);
  });

  it("caps an overlong description so the footer always fits, and closes a fence it leaves open", () => {
    const body = pullRequestBody(RUN, HEAD, { body: `\`\`\`\n${"y".repeat(64 * 1024)}`, source: "pr_draft" });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(PR_BODY_MAX_BYTES);
    expect(body.split("\n---\n")[0]?.length).toBeLessThanOrEqual(DRAFT_BODY_MAX_BYTES + 8);
    expect(body).toContain(`\n\`\`\`\n\n---\n\n${AGENT_TEXT_LABEL.pr_draft}`);
    expect(body.endsWith(`- Head: \`${"a".repeat(40)}\``)).toBe(true);
  });
});
