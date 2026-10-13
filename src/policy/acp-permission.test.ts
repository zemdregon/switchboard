/**
 * `decidePermission` (ADR-0036 item 9, owner decision 48; T4.8). Pure decision matrix: no answer grants what the
 * profile lacks, `allow_always` and `reject_always` are never selected, and the allow-everything answer is reachable
 * only in an approved bypass run.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AcpDeclarations, ResolvedProfile } from "../adapters/types.js";
import { type AcpPermissionSnapshot, approvedBypass, decidePermission, rejectionFor } from "./acp-permission.js";
import { resolveProfile } from "./profiles.js";
import type { PrivilegedScope } from "./types.js";

const root = mkdtempSync(path.join(tmpdir(), "sb-acp-perm-"));
const wt = path.join(root, "wt");
const outside = path.join(root, "outside");
const ctxDir = path.join(root, "context");
for (const d of [wt, outside, ctxDir]) mkdirSync(d);
writeFileSync(path.join(wt, "a.txt"), "a");
writeFileSync(path.join(outside, "secret.txt"), "s");
symlinkSync(outside, path.join(wt, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ALL_OPTIONS = [
  { optionId: "aa", name: "Always", kind: "allow_always" },
  { optionId: "a1", name: "Allow", kind: "allow_once" },
  { optionId: "ra", name: "Never", kind: "reject_always" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
];

const req = (toolCall: Record<string, unknown> | undefined, options: unknown[] = ALL_OPTIONS) => ({
  sessionId: "s",
  ...(toolCall ? { toolCall: { toolCallId: "t1", title: "x", ...toolCall } } : {}),
  options,
});
const at = (...p: string[]) => [{ path: path.join(...p) }];

const SCOPE_BASE: PrivilegedScope = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
  repository_config: { mode: "disabled" },
  bypass: false,
};
const privileged = (scope: Partial<PrivilegedScope>, bypassApproved: boolean): ResolvedProfile => ({
  name: "privileged",
  fileAccess: "scoped",
  shell: "scoped",
  network: "scoped",
  repoConfig: "scoped",
  bypassApproved,
  privilegedScope: { scope: { ...SCOPE_BASE, ...scope }, scopeHash: "a".repeat(64), approvalId: "apv_1" },
});
const snap = (profile: ResolvedProfile, writable = true): AcpPermissionSnapshot => ({
  profile,
  worktree: wt,
  writable,
  readOnlyContexts: [ctxDir],
});
const DECL: AcpDeclarations = {
  bypassModeIds: [],
  bypassConfigValues: [],
  parseExecute: (tc) => {
    const raw = (tc as { rawInput?: { command?: unknown } }).rawInput?.command;
    return Array.isArray(raw) && raw.every((w) => typeof w === "string") ? (raw as string[]) : null;
  },
  parseFetchHost: (tc) => {
    const url = (tc as { rawInput?: { url?: unknown } }).rawInput?.url;
    try {
      return typeof url === "string" ? new URL(url).hostname : null;
    } catch {
      return null;
    }
  },
};

describe("decidePermission: deny by default (ADR-0036 item 9.2)", () => {
  const NON_BYPASS: Array<[string, ResolvedProfile]> = [
    ["inspect-untrusted", resolveProfile("inspect-untrusted")],
    ["edit-untrusted", resolveProfile("edit-untrusted")],
    ["test-sandboxed", resolveProfile("test-sandboxed")],
    ["trusted-development", resolveProfile("trusted-development")],
    ["privileged without bypass", privileged({}, false)],
    ["privileged bypass scope, not approved", privileged({ bypass: true }, false)],
    ["privileged approved, scope without bypass", privileged({ bypass: false }, true)],
  ];
  // Requests that no non-bypass default profile grants.
  const OUTSIDE: Array<[string, ReturnType<typeof req>]> = [
    ["execute broad", req({ kind: "execute", rawInput: { command: ["rm", "-rf", "/"] } })],
    ["fetch", req({ kind: "fetch", rawInput: { url: "https://evil.example/" } })],
    ["think", req({ kind: "think" })],
    ["switch_mode", req({ kind: "switch_mode" })],
    ["other", req({ kind: "other", locations: at(wt, "a.txt") })],
    ["missing kind", req({ locations: at(wt, "a.txt") })],
    ["unknown kind", req({ kind: "teleport", locations: at(wt, "a.txt") })],
    ["no toolCall", req(undefined)],
    ["read outside the worktree", req({ kind: "read", locations: at(outside, "secret.txt") })],
    ["read via ..", req({ kind: "read", locations: [{ path: `${wt}/../outside/secret.txt` }] })],
    ["read via a symlink", req({ kind: "read", locations: at(wt, "escape", "secret.txt") })],
    ["edit via a symlink to a new file", req({ kind: "edit", locations: at(wt, "escape", "new.txt") })],
    ["relative location", req({ kind: "read", locations: [{ path: "a.txt" }] })],
    ["read without a location", req({ kind: "read" })],
    ["edit outside", req({ kind: "edit", locations: at(outside, "secret.txt") })],
    ["edit in a read-only context", req({ kind: "edit", locations: at(ctxDir, "x") })],
    ["malformed locations", req({ kind: "read", locations: "everything" })],
  ];
  for (const [pname, profile] of NON_BYPASS) {
    it.each(OUTSIDE)(`${pname}: %s is not allowed`, (_n, r) => {
      const d = decidePermission(r, snap(profile), DECL);
      expect(d.answer).not.toBe("allow_once");
      if (d.answer !== "cancel_turn") expect(d.optionId).toBe("r1");
    });
  }

  it("inspect-untrusted may read inside the worktree and a read-only context, but not edit", () => {
    const p = resolveProfile("inspect-untrusted");
    expect(decidePermission(req({ kind: "read", locations: at(wt, "a.txt") }), snap(p, false))).toMatchObject({
      answer: "allow_once",
      optionId: "a1",
    });
    expect(decidePermission(req({ kind: "search", locations: at(ctxDir) }), snap(p, false)).answer).toBe("allow_once");
    for (const kind of ["edit", "delete", "move"]) {
      expect(decidePermission(req({ kind, locations: at(wt, "a.txt") }), snap(p, false))).toMatchObject({
        answer: "reject_once",
        reason: "kind_not_in_profile",
      });
    }
  });

  it("edit-untrusted may edit inside the worktree (new files too) only on a writable workspace", () => {
    const p = resolveProfile("edit-untrusted");
    expect(decidePermission(req({ kind: "edit", locations: at(wt, "new", "b.txt") }), snap(p)).answer).toBe(
      "allow_once",
    );
    expect(decidePermission(req({ kind: "edit", locations: at(wt, "a.txt") }), snap(p, false)).answer).toBe(
      "reject_once",
    );
  });

  it("execute needs broad shell, or an allowlist entry matched through the adapter's parser", () => {
    const allow = { ...resolveProfile("trusted-development"), shellAllowlist: ["npm test"] };
    const run = (command: string[], d?: AcpDeclarations) =>
      decidePermission(req({ kind: "execute", rawInput: { command } }), snap(allow), d).answer;
    expect(run(["npm", "test"], DECL)).toBe("allow_once");
    expect(run(["npm", "test", "--", "x"], DECL)).toBe("reject_once");
    expect(run(["npm", "test"], undefined)).toBe("reject_once"); // no parser: never allowed
    const broad = { ...resolveProfile("trusted-development"), shell: "broad" as const };
    expect(decidePermission(req({ kind: "execute" }), snap(broad)).answer).toBe("allow_once");
    const scoped = privileged({}, false);
    expect(
      decidePermission(req({ kind: "execute", rawInput: { command: ["npm", "test"] } }), snap(scoped), DECL),
    ).toMatchObject({ answer: "allow_once" });
  });

  it("fetch needs network on, or an allowlisted host through the adapter's parser", () => {
    const fetch = (url: string) => req({ kind: "fetch", rawInput: { url } });
    const scoped = privileged({}, false);
    expect(decidePermission(fetch("https://registry.npmjs.org/x"), snap(scoped), DECL).answer).toBe("allow_once");
    expect(decidePermission(fetch("https://evil.example/"), snap(scoped), DECL).answer).toBe("reject_once");
    const policy = { ...resolveProfile("trusted-development"), network: "policy" as const };
    expect(decidePermission(fetch("https://any.example/"), snap(policy)).answer).toBe("allow_once");
  });
});

describe("decidePermission: option selection (ADR-0036 items 9.2 and 9.3)", () => {
  const p = resolveProfile("edit-untrusted");
  const edit = { kind: "edit", locations: at(wt, "a.txt") };

  it("selects allow_once even when allow_always is listed first", () => {
    expect(decidePermission(req(edit), snap(p))).toMatchObject({ answer: "allow_once", optionId: "a1" });
  });

  it("never selects allow_always, even when it is the only allow option", () => {
    const only = [ALL_OPTIONS[0], ALL_OPTIONS[3]];
    expect(decidePermission(req(edit, only), snap(p))).toMatchObject({ answer: "reject_once", optionId: "r1" });
  });

  it("never selects reject_always: without reject_once the answer is cancel_turn", () => {
    const d = decidePermission(req({ kind: "think" }, [ALL_OPTIONS[0], ALL_OPTIONS[2]]), snap(p));
    expect(d).toMatchObject({ answer: "cancel_turn", reason: "no_reject_option" });
  });

  it("rejectionFor picks reject_once, else cancel_turn, and never throws", () => {
    expect(rejectionFor(req(edit), "decision_timeout")).toMatchObject({ answer: "reject_once", optionId: "r1" });
    expect(rejectionFor({ options: [ALL_OPTIONS[0]] }, "x")).toMatchObject({ answer: "cancel_turn" });
    expect(rejectionFor(null, "x").answer).toBe("cancel_turn");
  });
});

describe("decidePermission: approved bypass run (owner decision 48)", () => {
  const bypass = privileged({ bypass: true, shell: { mode: "none" }, network: { mode: "off" } }, true);

  it("is reachable only with privileged, bypassApproved and a scope that sets bypass", () => {
    expect(approvedBypass(bypass)).toBe(true);
    expect(approvedBypass(privileged({ bypass: true }, false))).toBe(false);
    expect(approvedBypass(privileged({ bypass: false }, true))).toBe(false);
    expect(approvedBypass({ ...resolveProfile("trusted-development"), bypassApproved: true })).toBe(false);
  });

  it("allows every request with allow_once, never allow_always", () => {
    for (const r of [
      req({ kind: "execute", rawInput: { command: ["anything"] } }),
      req({ kind: "other" }),
      req({ kind: "edit", locations: at(outside, "secret.txt") }),
      req(undefined),
    ]) {
      expect(decidePermission(r, snap(bypass))).toMatchObject({ answer: "allow_once", optionId: "a1" });
    }
    expect(decidePermission(req({ kind: "read" }, [ALL_OPTIONS[0], ALL_OPTIONS[3]]), snap(bypass))).toMatchObject({
      answer: "reject_once",
      reason: "no_allow_once_option",
    });
  });

  it("the same requests are refused when the approval is missing", () => {
    const unapproved = privileged({ bypass: true, shell: { mode: "none" }, network: { mode: "off" } }, false);
    expect(decidePermission(req({ kind: "other" }), snap(unapproved)).answer).toBe("reject_once");
    expect(decidePermission(req({ kind: "execute" }), snap(unapproved)).answer).toBe("reject_once");
  });

  it("never throws on hostile input", () => {
    const hostile = [null, 42, "x", [], { toolCall: { kind: { toString: 1 } } }, { options: "x", toolCall: [] }];
    for (const h of hostile) expect(() => decidePermission(h, snap(resolveProfile("edit-untrusted")))).not.toThrow();
  });
});
