/**
 * ADR-0080 item 2: the submodule manifest is read from the umbrella commit by the controller, every used URL passes
 * the ADR-0068 rules and `project_sources`, and every refusal is a fixed reason naming only the path.
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectSourcesSettings } from "../config/index.js";
import { MAX_SUBMODULES, SubmoduleError, type SubmoduleReason } from "./errors.js";
import { type Fixture, gitmodulesText, HOST, makeFixture, makeUmbrella, OWNER } from "./fixtures/repos.js";
import { type ManifestOptions, readSubmoduleManifest, resolveSubmoduleUrl } from "./manifest.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("sb-sub-manifest-");
});
afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

const opts = (over: Partial<ManifestOptions> = {}): ManifestOptions => ({
  sources: () => fx.settings,
  umbrella: { host: HOST, owner: OWNER, repo: "umbrella" },
  exclude: [],
  writable: [],
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<SubmoduleError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SubmoduleError);
  return err as SubmoduleError;
}

describe("readSubmoduleManifest", () => {
  it("is empty for a commit without .gitmodules and without gitlinks", async () => {
    const u = makeUmbrella(fx, {}, undefined);
    const m = await readSubmoduleManifest(u.dir, "HEAD", opts());
    expect(m.commit).toBe(u.head);
    expect(m.entries).toEqual([]);
    expect(m.byKey.size).toBe(0);
    expect(m.readOnlyPaths).toEqual([]);
  });

  it("reads gitlinks and .gitmodules: relative URLs, duplicate-URL paths share a key, a wiki is never writable", async () => {
    const u = makeUmbrella(
      fx,
      { "lib/a": SHA_A, "dup/a": SHA_A, "lib/b": SHA_B, docs: SHA_C },
      gitmodulesText([
        ["a", "lib/a", `https://${HOST}/${OWNER}/lib-a.git`],
        ["a-again", "dup/a", `https://${HOST}/acme/LIB-A`],
        ["b.with.dots", "lib/b", "../lib-b.git"],
        ["wiki", "docs", `https://${HOST}/${OWNER}/core.wiki.git`],
      ]) + `[submodule "b.with.dots"]\n\tupdate = !touch /tmp/never\n\tbranch = evil\n`,
    );
    const m = await readSubmoduleManifest(u.dir, u.head, opts({ writable: ["*"] }));
    expect(m.entries.map((e) => [e.path, e.name, e.sha, e.key, e.wiki, e.writable])).toEqual([
      ["docs", "wiki", SHA_C, "github.test/acme/core.wiki", true, false],
      ["dup/a", "a-again", SHA_A, "github.test/acme/lib-a", false, true],
      ["lib/a", "a", SHA_A, "github.test/acme/lib-a", false, true],
      ["lib/b", "b.with.dots", SHA_B, "github.test/acme/lib-b", false, true],
    ]);
    expect(m.entries.find((e) => e.path === "lib/b")?.source).toEqual({ host: HOST, owner: OWNER, repo: "lib-b" });
    expect(m.byKey.get("github.test/acme/lib-a")?.map((e) => e.path)).toEqual(["dup/a", "lib/a"]);
    expect(m.readOnlyPaths).toEqual(["docs"]);

    const listed = await readSubmoduleManifest(u.dir, u.head, opts({ writable: ["lib/b", "docs"] }));
    expect(listed.entries.filter((e) => e.writable).map((e) => e.path)).toEqual(["lib/b"]);
    expect(listed.readOnlyPaths).toEqual(["docs", "dup/a", "lib/a"]);
  });

  it("drops excluded paths entirely (no declaration or URL check) and ignores declarations without a gitlink", async () => {
    const u = makeUmbrella(
      fx,
      { "lib/a": SHA_A, "vendor/x": SHA_B, "vendor/deep/y": SHA_C, undeclared: SHA_C },
      gitmodulesText([
        ["a", "lib/a", `https://${HOST}/${OWNER}/lib-a`],
        ["x", "vendor/x", "ext::sh -c touch% /tmp/pwned"],
        ["gone", "no/gitlink", "ssh://evil.example/x/y"],
      ]),
    );
    const m = await readSubmoduleManifest(u.dir, u.head, opts({ exclude: ["vendor", "undeclared"] }));
    expect(m.entries.map((e) => e.path)).toEqual(["lib/a"]);
  });

  const BAD_URLS: readonly (readonly [string, SubmoduleReason])[] = [
    ["file:///etc/repo", "SUBMODULE_URL_INVALID"],
    [`ssh://git@${HOST}/${OWNER}/x.git`, "SUBMODULE_URL_INVALID"],
    [`git@${HOST}:${OWNER}/x.git`, "SUBMODULE_URL_INVALID"],
    ["ext::sh -c touch% /tmp/pwned", "SUBMODULE_URL_INVALID"],
    [`http://${HOST}/${OWNER}/x.git`, "SUBMODULE_URL_INVALID"],
    [`https://user:token@${HOST}/${OWNER}/x.git`, "SUBMODULE_URL_INVALID"],
    [`https://${HOST}:8443/${OWNER}/x.git`, "SUBMODULE_URL_INVALID"],
    [`https://${HOST}/${OWNER}/x.git?q=1`, "SUBMODULE_URL_INVALID"],
    ["../../other/x", "SUBMODULE_URL_INVALID"],
    ["./x", "SUBMODULE_URL_INVALID"],
    ["/abs/path", "SUBMODULE_URL_INVALID"],
    ["", "SUBMODULE_URL_INVALID"],
    [`https://${HOST}/someone-else/x.git`, "SUBMODULE_SOURCE_NOT_ALLOWED"],
    [`https://elsewhere.test/${OWNER}/x.git`, "SUBMODULE_SOURCE_NOT_ALLOWED"],
  ];
  it.each(BAD_URLS)("refuses the URL %j with %s, naming the path and never the URL", async (url, reason) => {
    const u = makeUmbrella(fx, { lib: SHA_A }, gitmodulesText([["lib", "lib", url]]));
    const err = await refusal(readSubmoduleManifest(u.dir, u.head, opts()));
    expect(err.reason).toBe(reason);
    expect(err.path).toBe("lib");
    if (url !== "") expect(err.message).not.toContain(url);
    expect(err.code).toBe(reason === "SUBMODULE_SOURCE_NOT_ALLOWED" ? "PERMISSION_BLOCKED" : "INVALID_REQUEST");
  });

  it("refuses a relative URL when the umbrella's own source is unknown", async () => {
    const u = makeUmbrella(fx, { lib: SHA_A }, gitmodulesText([["lib", "lib", "../lib.git"]]));
    const { umbrella: _drop, ...noUmbrella } = opts();
    expect((await refusal(readSubmoduleManifest(u.dir, u.head, noUmbrella))).reason).toBe("SUBMODULE_URL_INVALID");
  });

  it("refuses a used entry with zero or two url values", async () => {
    const none = makeUmbrella(fx, { lib: SHA_A }, `[submodule "lib"]\n\tpath = lib\n`, "u1");
    expect((await refusal(readSubmoduleManifest(none.dir, none.head, opts()))).reason).toBe("SUBMODULE_URL_INVALID");
    const two = makeUmbrella(
      fx,
      { lib: SHA_A },
      `[submodule "lib"]\n\tpath = lib\n\turl = https://${HOST}/${OWNER}/a\n\turl = https://${HOST}/${OWNER}/b\n`,
      "u2",
    );
    expect((await refusal(readSubmoduleManifest(two.dir, two.head, opts()))).reason).toBe("SUBMODULE_URL_INVALID");
  });

  it("refuses an unsafe declared path such as ../escape, even when no gitlink uses it", async () => {
    const u = makeUmbrella(
      fx,
      { lib: SHA_A },
      gitmodulesText([
        ["lib", "lib", `https://${HOST}/${OWNER}/lib`],
        ["escape", "../escape", `https://${HOST}/${OWNER}/escape`],
      ]),
    );
    const err = await refusal(readSubmoduleManifest(u.dir, u.head, opts()));
    expect(err.reason).toBe("SUBMODULE_PATH_UNSAFE");
    expect(err.path).toBe("../escape");
    expect(err.code).toBe("INVALID_REQUEST");
  });

  it.each(["/abs", "a/./b", "a//b", "x/.git/y", "x/.GIT", "back\\slash", "ctl\u0001x"])(
    "refuses the declared path %j",
    async (p) => {
      const u = makeUmbrella(
        fx,
        { lib: SHA_A },
        `${gitmodulesText([["lib", "lib", `https://${HOST}/${OWNER}/lib`]])}[submodule "bad"]\n\tpath = "${p.replace(/\\/g, "\\\\")}"\n\turl = https://${HOST}/${OWNER}/bad\n`,
      );
      expect((await refusal(readSubmoduleManifest(u.dir, u.head, opts()))).reason).toBe("SUBMODULE_PATH_UNSAFE");
    },
  );

  it("refuses a gitlink with no matching declaration, or with two", async () => {
    const u = makeUmbrella(
      fx,
      { lib: SHA_A, other: SHA_B },
      gitmodulesText([["lib", "lib", `https://${HOST}/${OWNER}/l`]]),
    );
    const err = await refusal(readSubmoduleManifest(u.dir, u.head, opts()));
    expect([err.reason, err.path, err.code]).toEqual(["SUBMODULE_UNDECLARED", "other", "INVALID_REQUEST"]);

    const none = makeUmbrella(fx, { lib: SHA_A }, undefined, "u-none");
    expect((await refusal(readSubmoduleManifest(none.dir, none.head, opts()))).reason).toBe("SUBMODULE_UNDECLARED");

    const twice = makeUmbrella(
      fx,
      { lib: SHA_A },
      gitmodulesText([
        ["one", "lib", `https://${HOST}/${OWNER}/one`],
        ["two", "lib", `https://${HOST}/${OWNER}/two`],
      ]),
      "u-twice",
    );
    expect((await refusal(readSubmoduleManifest(twice.dir, twice.head, opts()))).reason).toBe("SUBMODULE_UNDECLARED");
  });

  it(`refuses more than ${MAX_SUBMODULES} gitlinks`, async () => {
    const links: Record<string, string> = {};
    for (let i = 0; i <= MAX_SUBMODULES; i++) links[`m/${i}`] = SHA_A;
    const u = makeUmbrella(fx, links, undefined);
    const err = await refusal(readSubmoduleManifest(u.dir, u.head, opts()));
    expect([err.reason, err.code]).toEqual(["SUBMODULE_MANIFEST_TOO_LARGE", "INVALID_REQUEST"]);
  });

  it("refuses an unknown commit, a malformed .gitmodules and an option-like commit as unreadable", async () => {
    const u = makeUmbrella(fx, {}, undefined);
    for (const c of ["no-such-ref", "--output=/tmp/x", ""]) {
      const err = await refusal(readSubmoduleManifest(u.dir, c, opts()));
      expect([err.reason, err.code]).toEqual(["SUBMODULE_MANIFEST_UNREADABLE", "TOOL_FAILURE"]);
    }
    const bad = makeUmbrella(fx, { lib: SHA_A }, '[submodule "lib"\n\tpath = lib\n', "u-bad");
    expect((await refusal(readSubmoduleManifest(bad.dir, bad.head, opts()))).reason).toBe(
      "SUBMODULE_MANIFEST_UNREADABLE",
    );
  });

  it("does not read include files named by .gitmodules", async () => {
    const u = makeUmbrella(
      fx,
      { lib: SHA_A },
      `[include]\n\tpath = /etc/gitconfig-evil\n${gitmodulesText([["lib", "lib", `https://${HOST}/${OWNER}/lib`]])}`,
    );
    const m = await readSubmoduleManifest(u.dir, u.head, opts());
    expect(m.entries.map((e) => e.key)).toEqual(["github.test/acme/lib"]);
  });

  it("reads project_sources through the live getter on every call", async () => {
    const u = makeUmbrella(fx, { lib: SHA_A }, gitmodulesText([["lib", "lib", `https://${HOST}/newco/lib`]]));
    let current: ProjectSourcesSettings = fx.settings;
    const o = opts({ sources: () => current });
    expect((await refusal(readSubmoduleManifest(u.dir, u.head, o))).reason).toBe("SUBMODULE_SOURCE_NOT_ALLOWED");
    current = { ...fx.settings, allowedOwners: [...fx.settings.allowedOwners, "newco"] };
    expect((await readSubmoduleManifest(u.dir, u.head, o)).entries).toHaveLength(1);
  });
});

describe("resolveSubmoduleUrl", () => {
  const umbrella = { host: HOST, owner: OWNER, repo: "umbrella" };
  it("resolves ../<repo>[.git] against the umbrella and parses absolute https URLs", () => {
    expect(resolveSubmoduleUrl("../x.git", umbrella)).toEqual({ host: HOST, owner: OWNER, repo: "x" });
    expect(resolveSubmoduleUrl("../x", umbrella)).toEqual({ host: HOST, owner: OWNER, repo: "x" });
    expect(resolveSubmoduleUrl(`https://${HOST}/o/r/`, undefined)).toEqual({ host: HOST, owner: "o", repo: "r" });
    for (const bad of ["../", "../a/b", "../..", "../.", "..\\x", "../x y", "../-x"]) {
      expect(resolveSubmoduleUrl(bad, umbrella)).toBeUndefined();
    }
  });
});
