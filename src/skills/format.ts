import { createHash } from "node:crypto";
import { DEFAULT_SECRET_PATTERNS, PREFIXED_PATTERNS } from "../artifacts/redact.js";
import { compileOperatorPattern, PATTERN_WINDOW } from "../git/safe-pattern.js";

/**
 * Skill source format, validator and canonicaliser (T16.1; FR-SKL-01, FR-SKL-02, FR-SKL-10; LLD §19.1, ADR-0056 items 1
 * and 10). Pure: bytes in, a canonical skill or one refusal reason out. A refusal message names the reason and the
 * field, never the body text and never a matched secret (FR-SKL-10).
 */

/** LLD §19.1 / §19.3 defaults (Assumptions) until T16.3 adds `skills.max_body_bytes` and `skills.max_names`. */
export const DEFAULT_MAX_BODY_BYTES = 32_768;
export const DEFAULT_MAX_NAMES = 64;
export const MAX_DESCRIPTION_CHARS = 280;

export const SKILL_NAME = /^[a-z][a-z0-9-]{1,47}$/u;
/** Config provider ids (`providers.<id>`); the loader is not consulted here, so only the shape is checked. */
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;

export type SkillRefusalReason =
  | "SKILL_ENCODING"
  | "SKILL_SIZE"
  | "SKILL_FRONT_MATTER_KEY"
  | "SKILL_MARKER"
  | "SKILL_SECRET"
  | "SKILL_REPOSITORY_SOURCE"
  | "SKILL_UNCHANGED"
  | "SKILL_LIMIT";

export interface SkillRefusal {
  readonly ok: false;
  readonly reason: SkillRefusalReason;
  /** Operator-facing; never holds body text or a matched secret. */
  readonly message: string;
}

export interface CanonicalSkill {
  readonly ok: true;
  readonly name: string;
  readonly description: string;
  /** `applies_to_providers` in source order, or `null` when absent (every provider). */
  readonly appliesTo: readonly string[] | null;
  /** Canonical body: LF line ends, no trailing whitespace, exactly one final LF. */
  readonly body: string;
  /** Re-serialised front matter plus body; the bytes stored in `<data_dir>/skills/<sha256>.md`. */
  readonly text: string;
  readonly sha256: string;
  /** Byte length of {@link text} (the stored file). */
  readonly sizeBytes: number;
}

export interface ValidateSkillOptions {
  /** The CLI `<name>` argument; the front matter `name` must equal it. */
  readonly expectedName?: string;
  /** `skills.max_body_bytes` (default {@link DEFAULT_MAX_BODY_BYTES}). */
  readonly maxBodyBytes?: number;
  /**
   * `git.sanitize_patterns` sources. LLD §19.1 refuses their "secret classes"; the configuration has no such class, so
   * every configured pattern is treated as one (Delegated, fail closed). Compiled by `compileOperatorPattern`.
   */
  readonly sanitizePatterns?: readonly string[];
}

/** Switchboard's own prompt delimiters (LLD §19.1 `SKILL_MARKER`), matched case-insensitively. */
const MARKERS: readonly RegExp[] = [
  /\[operator skills:/iu,
  /\[end of operator skills\]/iu,
  /\[skill [^\]\s@]+@\d/iu,
  /\[untrusted data:/iu,
  /\[end of untrusted data\]/iu,
  /\[instruction from the orchestrator\]/iu,
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing C0 controls other than tab and LF is the point
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/u;
const BOM = "﻿";

export function refusal(reason: SkillRefusalReason, message: string): SkillRefusal {
  return { ok: false, reason, message };
}

/**
 * Canonical text of a source (LLD §19.1): strip a UTF-8 BOM, CRLF and CR to LF, strip trailing whitespace on each line,
 * end with exactly one LF. Returns `undefined` for bytes that are not valid UTF-8.
 */
export function canonicalText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (text.startsWith(BOM)) text = text.slice(1);
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

function unquote(raw: string): string | undefined {
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    const inner = raw.slice(1, -1);
    // No escapes: a quote character of the same kind inside is refused rather than interpreted.
    // Trimmed so the re-serialised (possibly plain) value parses back to itself.
    return inner.includes(raw[0] as string) ? undefined : inner.trim();
  }
  if (/^["']/u.test(raw)) return undefined;
  // YAML: " #" starts a comment in a plain scalar.
  const hash = raw.search(/\s#/u);
  return (hash >= 0 ? raw.slice(0, hash) : raw).trim();
}

/** Plain unless re-parsing would change it (a leading quote, or " #"); {@link unquote} never yields both quote kinds plus " #" unquoted. */
function serialiseScalar(value: string): string {
  if (!/\s#|^["']/u.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

function parseProviderList(raw: string): string[] | undefined {
  const value = raw.replace(/\s#.*$/u, "").trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner === "") return undefined;
  const items = inner.split(",").map((s) => unquote(s.trim()));
  if (items.some((s) => s === undefined || !PROVIDER_ID.test(s))) return undefined;
  const list = items as string[];
  return new Set(list).size === list.length ? list : undefined;
}

function secretMatched(text: string, sanitizePatterns: readonly string[]): boolean {
  for (const re of [...DEFAULT_SECRET_PATTERNS, ...PREFIXED_PATTERNS]) {
    if (new RegExp(re.source, re.flags.replace("g", "")).test(text)) return true;
  }
  if (sanitizePatterns.length === 0) return false;
  const compiled = sanitizePatterns.map((p) => compileOperatorPattern(p));
  // Operator patterns run on bounded windows only (safe-pattern.ts); windows overlap by half, so any match up to
  // half a window long falls wholly inside one.
  const half = PATTERN_WINDOW / 2;
  for (const line of text.split("\n")) {
    for (let start = 0; start === 0 || start + half < line.length; start += half) {
      const window = line.slice(start, start + PATTERN_WINDOW);
      if (compiled.some((re) => re.test(window))) return true;
    }
  }
  return false;
}

/** Validate and canonicalise one skill source (LLD §19.1). Checks run in table order; the first failure is returned. */
export function validateSkillSource(
  bytes: Uint8Array,
  options: ValidateSkillOptions = {},
): CanonicalSkill | SkillRefusal {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const text = canonicalText(bytes);
  if (text === undefined) return refusal("SKILL_ENCODING", "skill source is not valid UTF-8");
  if (FORBIDDEN_CONTROL.test(text)) {
    return refusal("SKILL_ENCODING", "skill source contains a NUL byte or a control character other than tab and LF");
  }

  const lines = text.split("\n");
  if (lines[0] !== "---")
    return refusal("SKILL_FRONT_MATTER_KEY", "skill source does not start with a front matter block");
  const close = lines.indexOf("---", 1);
  if (close < 0) return refusal("SKILL_FRONT_MATTER_KEY", "front matter block is not closed by a '---' line");

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    if (line.trim() === "" || /^\s*#/u.test(line)) continue;
    const m = /^([A-Za-z0-9_.-]+):(?:\s(.*))?$/u.exec(line);
    if (!m) return refusal("SKILL_FRONT_MATTER_KEY", "front matter line is not a 'key: value' pair");
    const key = m[1] as string;
    if (key !== "name" && key !== "description" && key !== "applies_to_providers") {
      return refusal("SKILL_FRONT_MATTER_KEY", `front matter key '${key.slice(0, 64)}' is outside the closed set`);
    }
    if (fields.has(key)) return refusal("SKILL_FRONT_MATTER_KEY", `front matter key '${key}' appears twice`);
    fields.set(key, (m[2] ?? "").trim());
  }

  const name = unquote(fields.get("name") ?? "");
  if (!name) return refusal("SKILL_FRONT_MATTER_KEY", "front matter key 'name' is missing");
  if (!SKILL_NAME.test(name))
    return refusal("SKILL_FRONT_MATTER_KEY", "front matter 'name' does not match ^[a-z][a-z0-9-]{1,47}$");
  if (options.expectedName !== undefined && name !== options.expectedName) {
    return refusal("SKILL_FRONT_MATTER_KEY", "front matter 'name' does not equal the requested skill name");
  }
  const description = unquote(fields.get("description") ?? "");
  if (description === undefined)
    return refusal("SKILL_FRONT_MATTER_KEY", "front matter 'description' is not a plain one-line value");
  if (description === "")
    return refusal("SKILL_FRONT_MATTER_KEY", "front matter key 'description' is missing or empty");
  let appliesTo: string[] | null = null;
  const rawApplies = fields.get("applies_to_providers");
  if (rawApplies !== undefined) {
    const list = parseProviderList(rawApplies);
    if (!list) {
      return refusal(
        "SKILL_FRONT_MATTER_KEY",
        "front matter 'applies_to_providers' must be a non-empty flow list of distinct provider ids, e.g. [claude-code, codex]",
      );
    }
    appliesTo = list;
  }

  const bodyLines = lines.slice(close + 1);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  const body = bodyLines.length === 0 ? "" : `${bodyLines.join("\n")}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes === 0) return refusal("SKILL_SIZE", "skill body is empty");
  if (bodyBytes > maxBodyBytes)
    return refusal("SKILL_SIZE", `skill body is ${bodyBytes} bytes; the limit is ${maxBodyBytes}`);
  if ([...description].length > MAX_DESCRIPTION_CHARS) {
    return refusal("SKILL_SIZE", `skill description is over ${MAX_DESCRIPTION_CHARS} characters`);
  }

  // Markers are checked in the description too: it is shown to orchestrators by T16.9 (stricter than the LLD, fail closed).
  if (MARKERS.some((re) => re.test(body) || re.test(description))) {
    return refusal("SKILL_MARKER", "skill contains one of Switchboard's own prompt delimiters");
  }

  const front =
    `---\nname: ${name}\ndescription: ${serialiseScalar(description)}\n` +
    (appliesTo ? `applies_to_providers: [${appliesTo.join(", ")}]\n` : "") +
    "---\n";
  const canonical = front + body;
  if (secretMatched(canonical, options.sanitizePatterns ?? [])) {
    return refusal("SKILL_SECRET", "skill matches a secret pattern; the match is not shown");
  }

  return {
    ok: true,
    name,
    description,
    appliesTo,
    body,
    text: canonical,
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
    sizeBytes: Buffer.byteLength(canonical, "utf8"),
  };
}
