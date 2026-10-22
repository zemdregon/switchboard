/**
 * Pre-push secret scan (FR-GIT-11; ADR-0061; LLD §20.9; T9.14). Deterministic and in-process: the rule set is the
 * artifact secret redactor's ({@link SECRET_RULES} and {@link PREFIXED_RULES} of `src/artifacts/redact.ts`, each with
 * a stable id), run over the ADDED lines of the diff a push would publish. No model, no external scanner binary.
 *
 * What is recorded about a hit is the rule id, the path and the new-file line number: never the matched value, never
 * the line. The push library refuses a push with hits in every profile (`SECRET_SCAN_BLOCKED`), approved bypass runs
 * included; the only way through is the operator allowlist in configuration (`git.secret_scan.allow`, a rule id and
 * a path glob per entry) or a push by hand outside Switchboard. Nothing in a tool request can reach this module.
 *
 * Delegated choices (not owner-approved beyond owner decision 77):
 * - Every file is diffed as text (`--text`), so a `.gitattributes` line marking a path `binary` or `-diff` cannot
 *   hide added lines from the scan; files Git counts as binary are still listed (`binaryPaths`) as ADR-0061 says.
 * - Renames are not detected (`--no-renames`): the scan is a function of the two trees alone, never of a heuristic
 *   or of the repository's `diff.*` configuration, and a file moved into the outgoing diff is scanned whole.
 * - Allowlist globs match the repository-relative path exactly (`vendor/**` for a tree), not a directory prefix.
 * - At most {@link MAX_SECRET_SCAN_HITS} hits and {@link MAX_SECRET_SCAN_BINARY_PATHS} binary paths are listed; the
 *   counts are always exact. A diff too large for the controller's Git helper fails the push closed (`GIT_FAILED`).
 */
import { PREFIXED_RULES, SECRET_RULES, type SecretRule } from "../artifacts/redact.js";
import { git } from "../workspace/git.js";

/** Every rule the scanner applies, in order: the redactor's value rules, then its prefixed rules. */
export const SECRET_SCAN_RULES: readonly SecretRule[] = [...SECRET_RULES, ...PREFIXED_RULES];

/** The stable rule ids an operator allowlist entry may name. */
export const SECRET_SCAN_RULE_IDS: ReadonlySet<string> = new Set(SECRET_SCAN_RULES.map((r) => r.id));

/** Most hits listed in one report and in the push event (the count is always exact). */
export const MAX_SECRET_SCAN_HITS = 100;
/** Most binary paths listed in one report and in the push event (the count is always exact). */
export const MAX_SECRET_SCAN_BINARY_PATHS = 100;

/** One finding: rule id, path and new-file line number. Never the value. */
export interface SecretScanHit {
  readonly rule_id: string;
  readonly path: string;
  readonly line: number;
}

/** One operator allowlist entry (`git.secret_scan.allow[]`): a rule id and a repository-relative path glob. */
export interface SecretScanAllowEntry {
  readonly rule_id: string;
  readonly path: string;
}

export interface SecretScanReport {
  /** Hits not covered by the allowlist, in diff order, at most {@link MAX_SECRET_SCAN_HITS}. */
  readonly hits: readonly SecretScanHit[];
  /** Exact number of hits not covered by the allowlist. */
  readonly hitCount: number;
  /** Exact number of hits the allowlist covered (recorded so a silent allowlist is visible in the event). */
  readonly allowedCount: number;
  /** Paths Git counts as binary (their content was still diffed as text), at most {@link MAX_SECRET_SCAN_BINARY_PATHS}. */
  readonly binaryPaths: readonly string[];
  readonly binaryCount: number;
}

/** Thrown by {@link compileSecretScanAllow} for an entry naming no rule or an empty glob. */
export class SecretScanAllowError extends Error {
  override readonly name = "SecretScanAllowError";
}

export type SecretScanAllow = (ruleId: string, path: string) => boolean;

/**
 * Translate a simple glob to an anchored regular expression: `**` any characters including `/`, `**` followed by `/`
 * zero or more directories, `*` any characters except `/`, `?` one character except `/`. Everything else is literal.
 * The same grammar as the retrieval exclusion globs (`src/retrieval/denylist.ts`), kept here on purpose: the push
 * path must not import `src/retrieval` (FR-RAG-07 import boundary, `src/retrieval/import-boundary.test.ts`).
 */
export function allowGlobToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\/+/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "su");
}

/** Compile the operator allowlist into a predicate; an unknown rule id or an empty glob is a configuration error. */
export function compileSecretScanAllow(entries: readonly SecretScanAllowEntry[] = []): SecretScanAllow {
  const compiled = entries.map((e, i) => {
    if (!SECRET_SCAN_RULE_IDS.has(e.rule_id)) {
      throw new SecretScanAllowError(
        `[${i}].rule_id: unknown rule ${JSON.stringify(e.rule_id)} (known: ${[...SECRET_SCAN_RULE_IDS].join(", ")})`,
      );
    }
    if (e.path.trim() === "") throw new SecretScanAllowError(`[${i}].path: must be a non-empty path glob`);
    return { ruleId: e.rule_id, re: allowGlobToRegExp(e.path) };
  });
  return (ruleId, path) => compiled.some((c) => c.ruleId === ruleId && c.re.test(path));
}

/** The rules as single-match tests (no `g` flag, so no `lastIndex` state between lines). */
const TESTS: readonly { id: string; re: RegExp }[] = SECRET_SCAN_RULES.map((r) => ({
  id: r.id,
  re: new RegExp(r.pattern.source, r.pattern.flags.replace("g", "")),
}));

/** Rule ids whose pattern matches `text` (one line of added content), in rule order. */
export function matchingRuleIds(text: string): string[] {
  return TESTS.filter((t) => t.re.test(text)).map((t) => t.id);
}

/**
 * Scan a unified diff (as produced by {@link outgoingDiffArgs}) for secrets in its added lines. Pure: the same text
 * and allowlist give the same report. `binaryPaths` come from `numstat` (see {@link scanOutgoingDiff}), not from here.
 */
export function scanDiffText(
  diff: string,
  allow: SecretScanAllow = () => false,
): Omit<SecretScanReport, "binaryPaths" | "binaryCount"> {
  const hits: SecretScanHit[] = [];
  let hitCount = 0;
  let allowedCount = 0;
  let path: string | undefined;
  let inHunk = false;
  let nextLine = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      path = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("+++ ")) path = parseHeaderPath(line.slice(4));
      else if (line.startsWith("@@ ")) {
        inHunk = true;
        nextLine = hunkStart(line);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      nextLine = hunkStart(line);
      continue;
    }
    if (line.startsWith("+")) {
      const at = nextLine;
      nextLine += 1;
      if (path === undefined) continue; // `+++ /dev/null`: a deletion has no added lines; defensive
      for (const ruleId of matchingRuleIds(line.slice(1))) {
        if (allow(ruleId, path)) {
          allowedCount += 1;
          continue;
        }
        hitCount += 1;
        if (hits.length < MAX_SECRET_SCAN_HITS) hits.push({ rule_id: ruleId, path, line: at });
      }
      continue;
    }
    if (line.startsWith(" ")) nextLine += 1;
    // `-` lines and `\ No newline at end of file` do not move the new-file line counter.
  }
  return { hits, hitCount, allowedCount };
}

/** New-file start line of `@@ -a[,b] +c[,d] @@`; 0 when the header is malformed (then every line counts from 0). */
function hunkStart(header: string): number {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return m ? Number(m[1]) : 0;
}

/** Path of a `+++ b/<path>` header (`/dev/null` is no path); Git's C-style quoting is undone. */
function parseHeaderPath(rest: string): string | undefined {
  // Git appends one tab after a name that contains whitespace (so patch tools can find its end); a name that needs
  // quoting is quoted as a whole, with the tab (if any) after the closing quote.
  const trimmed = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
  const unquoted = trimmed.startsWith('"') ? unquoteC(trimmed) : trimmed;
  if (unquoted === "/dev/null") return undefined;
  return unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
}

/** Undo Git's C-style quoting (`"..."` with `\\`, `\"`, `\t`, `\n`, `\ooo`); bytes are rebuilt as UTF-8. */
export function unquoteC(quoted: string): string {
  const end = quoted.lastIndexOf('"');
  const body = quoted.slice(1, end > 0 ? end : undefined);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[i + 1] ?? "";
    i += 1;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? "")) {
        i += 1;
        oct += body[i] as string;
      }
      bytes.push(Number.parseInt(oct, 8) & 0xff);
    } else {
      const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
      bytes.push(map[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Diff arguments for the outgoing range (LLD §20.9): added lines only (`-U0`), every file as text, no renames, fixed
 * prefixes and no colour so the repository's `diff.*` configuration cannot change the shape the parser reads. The
 * controller's Git helper adds `--no-textconv --no-ext-diff` and neutralises every filter and diff driver.
 */
export function outgoingDiffArgs(from: string, head: string): string[] {
  return [
    "diff",
    "-U0",
    "--inter-hunk-context=0",
    "--text",
    "--no-renames",
    "--no-color",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--end-of-options",
    from,
    head,
  ];
}

/** Paths Git counts as binary in the range (`numstat` prints `-` for both counts), NUL-separated so never quoted. */
export async function binaryPathsInRange(repo: string, from: string, head: string): Promise<string[]> {
  const r = await git(["diff", "--numstat", "-z", "--no-renames", "--no-relative", "--end-of-options", from, head], {
    cwd: repo,
  });
  const out: string[] = [];
  for (const entry of r.stdout.toString("utf8").split("\0")) {
    if (entry === "") continue;
    const [added, deleted, p] = entry.split("\t");
    if (added === "-" && deleted === "-" && p !== undefined && p !== "") out.push(p);
  }
  return out;
}

/**
 * Scan the diff `from..head` of `repo` (both commit ids) through the controller's hardened Git helper. Throws
 * `GitError` when Git fails or the output exceeds the helper's buffer; the push library records that as `GIT_FAILED`
 * (fail closed), never as a clean scan.
 */
export async function scanOutgoingDiff(
  repo: string,
  from: string,
  head: string,
  allow: SecretScanAllow = () => false,
): Promise<SecretScanReport> {
  const r = await git(outgoingDiffArgs(from, head), { cwd: repo });
  const text = scanDiffText(r.stdout.toString("utf8"), allow);
  const binary = await binaryPathsInRange(repo, from, head);
  return {
    ...text,
    binaryPaths: binary.slice(0, MAX_SECRET_SCAN_BINARY_PATHS),
    binaryCount: binary.length,
  };
}

/** Event type of one finding (LLD §20.9): `{stage, rule_id, path, line}`; never the value. */
export const SECRET_SCAN_HIT_EVENT = "secret_scan_hit";

/**
 * Event type of the operator acknowledgement of a refused push (`switchboard git ack-secret-scan`, LLD §20.9):
 * `{push_id, acknowledged_by, ref, head_sha}`. It clears `secret_scan_blocked` for that refusal only; it never allows
 * a push.
 */
export const SECRET_SCAN_ACKNOWLEDGED_EVENT = "secret_scan_acknowledged";

/**
 * Whether the newest decisive `git_push` event of a meta-session was a `SECRET_SCAN_BLOCKED` refusal (FR-CTL-03
 * `secret_scan_blocked`, LLD §20.9): an `ACCEPTED` push clears it; a refusal for another reason decides nothing; a
 * refusal whose `push_id` is in `acknowledged` (operator `git ack-secret-scan`) clears it until the next refusal.
 * `payloads` are `git_push` event payloads, NEWEST FIRST.
 */
export function secretScanBlockedFromPushEvents(
  payloads: Iterable<unknown>,
  acknowledged: ReadonlySet<string> = new Set(),
): boolean {
  for (const p of payloads) {
    if (typeof p !== "object" || p === null) continue;
    const { outcome, reason, push_id } = p as { outcome?: unknown; reason?: unknown; push_id?: unknown };
    if (reason === "SECRET_SCAN_BLOCKED") return !(typeof push_id === "string" && acknowledged.has(push_id));
    if (outcome === "ACCEPTED") return false;
  }
  return false;
}

/*
 * Refusal findings (ADR-0075): what a caller of a refused push is told, so an agent can find and fix the lines. Rule
 * id, path and line only, exactly what the `secret_scan_hit` events hold; never the value, never the line.
 *
 * Delegated choices (not owner-approved):
 * - The structured list carries every hit the report kept (at most {@link MAX_SECRET_SCAN_HITS}) with the exact count;
 *   `findings_truncated` is set when the list is shorter than the count.
 * - A path longer than {@link MAX_SECRET_SCAN_FINDING_PATH} characters is cut (`path_truncated: true`), which bounds
 *   the agent tool's answer well below the channel's response limit.
 * - The message names at most {@link MAX_SECRET_SCAN_MESSAGE_FINDINGS} findings within
 *   {@link SECRET_SCAN_MESSAGE_LIST_BUDGET} characters, then "and N more"; a path that is not plain printable ASCII
 *   (control characters, quotes, separators, non-ASCII) is shown as a JSON string with every other character escaped,
 *   so a path from the diff cannot inject a line break, a terminal sequence or a bidirectional override.
 */

/** Most findings named in a refusal message (the structured list keeps every recorded hit). */
export const MAX_SECRET_SCAN_MESSAGE_FINDINGS = 20;
/** Most characters the message's list of findings may take before "and N more". */
export const SECRET_SCAN_MESSAGE_LIST_BUDGET = 1200;
/** Most characters of one path in a refusal's findings (longer paths are cut and marked). */
export const MAX_SECRET_SCAN_FINDING_PATH = 512;
/** Most characters of one path shown in the message (before quoting). */
const MESSAGE_PATH_MAX = 160;

/** One finding as a refusal names it: rule id, repository-relative path and new-file line. Never the value. */
export interface SecretScanFinding {
  readonly rule_id: string;
  readonly path: string;
  readonly line: number;
  readonly path_truncated?: true;
}

/** The findings of a refused push, as `publish_run`, the agent `push` tool and `switchboard git push` return them. */
export interface SecretScanFindings {
  readonly findings: readonly SecretScanFinding[];
  /** Exact number of findings not covered by the allowlist. */
  readonly finding_count: number;
  readonly findings_truncated?: true;
}

/** The refusal view of a report's hits (`hits` as kept by the report, `hitCount` exact). */
export function secretScanFindings(scan: {
  readonly hits: readonly SecretScanHit[];
  readonly hitCount: number;
}): SecretScanFindings {
  const findings = scan.hits.slice(0, MAX_SECRET_SCAN_HITS).map((h): SecretScanFinding => {
    const cut = h.path.length > MAX_SECRET_SCAN_FINDING_PATH;
    return {
      rule_id: h.rule_id,
      path: cut ? h.path.slice(0, MAX_SECRET_SCAN_FINDING_PATH) : h.path,
      line: h.line,
      ...(cut ? { path_truncated: true as const } : {}),
    };
  });
  const count = Math.max(scan.hitCount, findings.length);
  return { findings, finding_count: count, ...(findings.length < count ? { findings_truncated: true as const } : {}) };
}

/** A path as the message shows it: bare when plain printable ASCII, else a JSON string escaping every other character. */
export function messagePath(p: string, truncated = false): string {
  const cut = p.length > MESSAGE_PATH_MAX;
  const shown = cut ? p.slice(0, MESSAGE_PATH_MAX) : p;
  const suffix = cut || truncated ? "..." : "";
  if (/^[A-Za-z0-9._/@+=,~-]+$/u.test(shown)) return `${shown}${suffix}`;
  // Per UTF-16 code unit (no `u` flag), so an astral character becomes a valid surrogate-pair escape.
  const quoted = JSON.stringify(shown).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${quoted}${suffix}`;
}

/** How to get past a refusal, in one sentence (appended to every refusal message). */
export const SECRET_SCAN_FIX_HINT =
  "Remove each value from the change (in tests, build fake values at run time instead of committing them); the " +
  "operator can allow a rule at a path with git.secret_scan.allow.";

/**
 * The readable list for a refusal message: `2 secret-scan findings: github_token at test/a.ts:12; jwt at src/x.ts:4`,
 * at most {@link MAX_SECRET_SCAN_MESSAGE_FINDINGS} entries within {@link SECRET_SCAN_MESSAGE_LIST_BUDGET} characters,
 * then `; and N more`. Rule ids are the closed set; paths go through {@link messagePath}.
 */
export function describeSecretScanFindings(f: SecretScanFindings): string {
  const parts: string[] = [];
  let used = 0;
  for (const x of f.findings) {
    if (parts.length >= MAX_SECRET_SCAN_MESSAGE_FINDINGS) break;
    const part = `${x.rule_id} at ${messagePath(x.path, x.path_truncated === true)}:${x.line}`;
    if (parts.length > 0 && used + part.length + 2 > SECRET_SCAN_MESSAGE_LIST_BUDGET) break;
    parts.push(part);
    used += part.length + 2;
  }
  const more = f.finding_count - parts.length;
  const noun = f.finding_count === 1 ? "finding" : "findings";
  return `${f.finding_count} secret-scan ${noun}: ${parts.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}
