import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createThrowawaySigner, gpgAvailable, type ThrowawaySigner } from "../git/fixtures/throwaway-gpg.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });

let tmp: string;
let roots: string;
let repo: string;
let configPath: string;

function mkRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "x\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "init");
}
const ctx = (over: Record<string, unknown> = {}) => ({
  id: "main",
  kind: "repository",
  path: repo,
  base_ref: "main",
  ...over,
});
const project = (over: Record<string, unknown> = {}) => ({
  id: "web-app",
  name: "Web app",
  contexts: [ctx()],
  ...over,
});
function writeConfig(projects?: unknown[]) {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: path.join(tmp, "data"),
      allowed_roots: [roots],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      ...(projects ? { projects } : {}),
    }),
  );
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-prj-")));
  roots = path.join(tmp, "roots");
  repo = path.join(roots, "web-app");
  mkRepo(repo);
  configPath = path.join(tmp, "config.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}
interface Report {
  ok: boolean;
  config_failures: { path: string; code: string; message: string }[];
  projects: { id: string; ok: boolean; failures: { path: string; code: string; message: string }[] }[];
}
const validateJson = async (...args: string[]) => {
  const r = await run(["projects", "validate", "--json", ...args]);
  return { code: r.code, report: JSON.parse(r.out) as Report };
};

describe("projects list | show (T9.1, FR-PRJ-08)", () => {
  it("lists and shows a host project with --json", async () => {
    writeConfig([project({ max_trust_profile: "edit-untrusted", allowed_providers: ["claude-code"] })]);
    const list = await run(["projects", "list", "--json"]);
    expect(list.code).toBe(0);
    const parsed = JSON.parse(list.out);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]).toMatchObject({
      id: "web-app",
      name: "Web app",
      environment: { kind: "host" },
      max_trust_profile: "edit-untrusted",
      allowed_providers: ["claude-code"],
      contexts: [
        {
          id: "main",
          kind: "repository",
          path: repo,
          base_ref: "main",
          primary: true,
          writable: true,
          push: { policy: "none" },
          sign: false,
          finalize_commit: false,
        },
      ],
    });
    const show = await run(["projects", "show", "web-app", "--json"]);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out).project.id).toBe("web-app");
    const text = await run(["projects", "show", "web-app"]);
    expect(text.out).toContain("Project web-app: Web app");
    expect((await run(["projects", "list"])).out).toContain("web-app\thost");
  });

  it("reports an unknown project and a usage error", async () => {
    writeConfig([project()]);
    const unknown = await run(["projects", "show", "nope", "--json"]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error.code).toBe("NOT_FOUND");
    expect((await run(["projects", "show"])).code).toBe(2);
    expect((await run(["projects", "bogus"])).code).toBe(2);
  });

  it("lists nothing for a config without projects and leaves other commands unchanged", async () => {
    writeConfig();
    const list = await run(["projects", "list", "--json"]);
    expect(JSON.parse(list.out)).toEqual({ schema_version: 1, projects: [] });
    expect((await run(["runs", "list", "--json"])).code).toBe(0);
    expect((await validateJson()).report).toMatchObject({ ok: true, projects: [] });
  });
});

describe("projects validate (T9.1, FR-PRJ-01, 02, 04)", () => {
  it("passes a valid host project", async () => {
    writeConfig([project()]);
    const { code, report } = await validateJson();
    expect(code).toBe(0);
    expect(report).toEqual({
      schema_version: 1,
      ok: true,
      projects: [{ id: "web-app", ok: true, failures: [] }],
      config_failures: [],
    });
    expect((await run(["projects", "validate"])).out).toContain("[ok] project web-app");
  });

  it("rejects an unknown context kind with the path and allowed values", async () => {
    writeConfig([project({ contexts: [ctx({ kind: "database" })] })]);
    const { code, report } = await validateJson();
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.config_failures[0]?.path).toBe("$.projects[0].contexts[0].kind");
    expect(report.config_failures[0]?.message).toBe("must be one of repository");
  });

  it("rejects unknown keys, bad project ids and duplicate ids with JSON paths", async () => {
    writeConfig([project({ surprise: 1 }), project({ id: "Bad_Id" })]);
    let { report } = await validateJson();
    const msgs = report.config_failures.map((f: { path: string; message: string }) => `${f.path}: ${f.message}`);
    expect(msgs).toContain("$.projects[0].surprise: unknown key (not permitted)");
    expect(msgs.some((m: string) => m.startsWith("$.projects[1].id:"))).toBe(true);
    writeConfig([project(), project()]);
    report = (await validateJson()).report;
    expect(report.config_failures[0]?.path).toBe("$.projects[1].id");
    expect(report.config_failures[0]?.message).toMatch(/duplicate project id "web-app"/);
  });

  it("requires exactly one primary context and a read-only non-primary context", async () => {
    const second = ctx({ id: "docs" });
    writeConfig([project({ contexts: [ctx(), second] })]);
    let r = await validateJson();
    expect(r.report.config_failures[0]?.message).toMatch(/exactly one context must be primary/);
    writeConfig([project({ contexts: [ctx({ primary: true }), { ...second, writable: true }] })]);
    r = await validateJson();
    expect(r.report.config_failures[0]?.path).toBe("$.projects[0].contexts[1].writable");
  });

  it("rejects a pushing context without an identity", async () => {
    writeConfig([
      project({ contexts: [ctx({ push: { policy: "branch", remote: "origin", branch_prefix: "switchboard/" } })] }),
    ]);
    const { report } = await validateJson();
    expect(report.config_failures[0]?.path).toBe("$.projects[0].contexts[0].identity");
  });

  it("rejects a path outside every allowed root", async () => {
    const outside = path.join(tmp, "outside");
    mkRepo(outside);
    writeConfig([project({ contexts: [ctx({ path: outside })] })]);
    const { code, report } = await validateJson();
    expect(code).toBe(1);
    expect(report.projects[0]?.failures[0]).toMatchObject({
      path: "$.projects[0].contexts[0].path",
      code: "OUTSIDE_ALLOWED_ROOT",
    });
  });

  it("rejects a .. escape and a symlink escape", async () => {
    const outside = path.join(tmp, "outside");
    mkRepo(outside);
    symlinkSync(outside, path.join(roots, "link"));
    writeConfig([
      project({ id: "dots", contexts: [ctx({ path: `${roots}/web-app/../../outside` })] }),
      project({ id: "link", contexts: [ctx({ path: path.join(roots, "link") })] }),
    ]);
    const { report } = await validateJson();
    expect(report.projects.map((p) => p.failures[0]?.code)).toEqual(["OUTSIDE_ALLOWED_ROOT", "OUTSIDE_ALLOWED_ROOT"]);
  });

  it("rejects a relative path, a missing path, a non-Git directory and a missing base ref", async () => {
    const plain = path.join(roots, "plain");
    mkdirSync(plain);
    writeConfig([
      project({ id: "rel", contexts: [ctx({ path: "web-app" })] }),
      project({ id: "gone", contexts: [ctx({ path: path.join(roots, "gone") })] }),
      project({ id: "plain", contexts: [ctx({ path: plain })] }),
      project({ id: "noref", contexts: [ctx({ base_ref: "nope" })] }),
    ]);
    const { code, report } = await validateJson();
    expect(code).toBe(1);
    expect(report.projects.map((p) => p.failures[0]?.code)).toEqual([
      "PATH_NOT_ABSOLUTE",
      "PATH_NOT_FOUND",
      "NOT_A_GIT_REPO",
      "BASE_REF_NOT_FOUND",
    ]);
    expect(report.projects[3]?.failures[0]?.path).toBe("$.projects[3].contexts[0].base_ref");
  });

  it("fails a container project with the M10 message but still lists and loads it", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    writeConfig([project({ environment: { kind: "container", image_digest: digest } })]);
    const { code, report } = await validateJson();
    expect(code).toBe(1);
    expect(report.projects[0]?.failures[0]).toEqual({
      path: "$.projects[0].environment.kind",
      code: "ENVIRONMENT_NOT_IMPLEMENTED",
      message: "container environments are not implemented yet (M10)",
    });
    expect((await run(["projects", "list"])).code).toBe(0);
    expect((await run(["projects", "validate"])).out).toContain("container environments are not implemented yet (M10)");
  });

  it("requires an image digest for container and forbids container fields on host", async () => {
    writeConfig([project({ environment: { kind: "container" } })]);
    expect((await validateJson()).report.config_failures[0]?.path).toBe("$.projects[0].environment.image_digest");
    writeConfig([project({ environment: { kind: "host", limits: { cpus: 1 } } })]);
    expect((await validateJson()).report.config_failures[0]?.path).toBe("$.projects[0].environment.limits");
  });

  it("validates one project by id, and reports an unknown id", async () => {
    const outside = path.join(tmp, "outside");
    mkRepo(outside);
    writeConfig([project(), project({ id: "bad-one", contexts: [ctx({ path: outside })] })]);
    const only = await validateJson("web-app");
    expect(only.code).toBe(0);
    expect(only.report.projects).toHaveLength(1);
    const unknown = await run(["projects", "validate", "nope", "--json"]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error.code).toBe("NOT_FOUND");
  });
});

describe("projects validate: commit signing (T9.10, FR-GIT-10, BR-33)", () => {
  const identity = { name: "Ada Maintainer", email: "ada@example.test" };

  it("refuses sign on a context that can never publish (no identity, or not the primary writable one)", async () => {
    writeConfig([project({ contexts: [ctx({ sign: true })] })]);
    expect((await validateJson()).report.config_failures[0]?.path).toBe("$.projects[0].contexts[0].identity");
    const second = path.join(roots, "second");
    mkRepo(second);
    writeConfig([
      project({
        contexts: [
          ctx({ primary: true, identity }),
          ctx({ id: "other", path: second, writable: false, identity, sign: true }),
        ],
      }),
    ]);
    expect((await validateJson()).report.config_failures[0]?.path).toBe("$.projects[0].contexts[1].sign");
  });

  it("does not try to sign when sign is off (no signing tools or variables needed)", async () => {
    writeConfig([project({ contexts: [ctx({ identity })] })]);
    const { code, report } = await validateJson();
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
  });

  it("refuses a repository whose own configuration sets a signing program, without running it", async () => {
    const marker = path.join(tmp, "evil.ran");
    const evil = path.join(tmp, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    g(repo, "config", "gpg.program", evil);
    writeConfig([project({ contexts: [ctx({ identity, sign: true })] })]);
    const { code, report } = await validateJson();
    expect(code).toBe(1);
    expect(report.projects[0]?.failures).toEqual([
      expect.objectContaining({ path: "$.projects[0].contexts[0].sign", code: "SIGNING_CONFIG_UNSAFE" }),
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  describe.skipIf(!gpgAvailable())("with a throwaway GnuPG key", () => {
    let signer: ThrowawaySigner;
    beforeEach(() => {
      signer = createThrowawaySigner();
    });
    afterEach(() => signer.dispose());

    it("passes with a test signature from the operator's setup, and fails without a usable key", async () => {
      writeConfig([project({ contexts: [ctx({ identity, sign: true })] })]);
      const ok = await run(["projects", "validate", "--json"], signer.env);
      expect(ok.code, ok.out).toBe(0);
      expect(JSON.parse(ok.out).ok).toBe(true);
      writeFileSync(
        path.join(signer.home, ".gitconfig"),
        "[user]\n\tsigningkey = 0000000000000000000000000000000000000000\n",
      );
      const bad = await run(["projects", "validate", "--json"], signer.env);
      expect(bad.code).toBe(1);
      const failures = (JSON.parse(bad.out) as Report).projects[0]?.failures;
      expect(failures).toEqual([
        expect.objectContaining({ path: "$.projects[0].contexts[0].sign", code: "SIGNING_UNAVAILABLE" }),
      ]);
      // Neither the key's fingerprint nor the key directory is printed.
      expect(bad.out).not.toContain(signer.fingerprint);
      expect(bad.out).not.toContain(signer.gnupgHome);
    });
  });
});
