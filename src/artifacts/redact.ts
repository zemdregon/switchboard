/** A redaction function maps content to content with secrets removed. It must be deterministic (same input, same output). */
export type Redactor = (content: Buffer) => Buffer;

export const REDACTION_MARKER = "[REDACTED]";

/**
 * One secret rule: a stable id (recorded by the FR-GIT-11 scanner instead of the matched value, `src/git/secret-scan.ts`)
 * and its pattern. Every pattern carries the `g` flag for `String.replace`; the scanner copies it without `g`.
 */
export interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * Default secret rules (FR-TEL-03, NFR-SEC-01, TDD §3.3 layer 3). Proposed: a best-effort safety net for common token
 * shapes, not a guarantee; the primary control is never routing credentials into artifacts at all. T9.14 (ADR-0061,
 * LLD §20.9) gave each rule a stable id and made this list the pre-push scanner's rule set too: one rule set, one
 * place to maintain it. Ids are part of the operator allowlist (`git.secret_scan.allow`) and must not be renamed.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // PEM private key blocks (whole block, or an unterminated header through the end of input).
  {
    id: "pem_private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  // AWS access key IDs.
  { id: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (classic prefixed and fine-grained).
  { id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: "github_fine_grained_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  // `sk-` style API keys (includes sk-ant-..., sk-proj-...).
  { id: "sk_api_key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g },
  // Slack tokens.
  { id: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // JSON web tokens.
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Switchboard's own per-run tool-channel token (T9.4, `src/git/tool-protocol.ts`): prefix plus 43 base64url characters.
  { id: "switchboard_tool_token", pattern: /sbt1_[A-Za-z0-9_-]{43}/g },
  // Switchboard's OAuth access and refresh tokens and authorization codes (T13.3, T13.8; T13.5, FR-MCP-15): prefix plus
  // 43 base64url characters.
  { id: "switchboard_oauth_token", pattern: /sb(?:at|rt|ac)_[A-Za-z0-9_-]{43}/g },
];

/** Rules that keep a prefix (the header or key name, capture group 1) and match only the secret value after it. */
export const PREFIXED_RULES: readonly SecretRule[] = [
  // Authorization: Bearer <token> / Basic <token>, and bare "Bearer <token>".
  { id: "bearer_authorization", pattern: /(\bBearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi },
  // key=value or "key": "value" for credential-looking names.
  {
    id: "credential_assignment",
    pattern:
      /(\b(?:aws_secret_access_key|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)["']?[ \t]*[:=][ \t]*["']?)[^\s"',;]{8,}/gi,
  },
];

/** Default secret patterns, in rule order (the patterns of {@link SECRET_RULES}). */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = SECRET_RULES.map((r) => r.pattern);

/** Patterns that keep a prefix (the header or key name) and replace only the secret value ({@link PREFIXED_RULES}). */
export const PREFIXED_PATTERNS: readonly RegExp[] = PREFIXED_RULES.map((r) => r.pattern);

/** Build a redactor from the default patterns plus optional extra patterns (which must carry the `g` flag). */
export function createSecretRedactor(extraPatterns: readonly RegExp[] = []): Redactor {
  const full = [...DEFAULT_SECRET_PATTERNS, ...extraPatterns];
  return (content) => {
    // latin1 round-trips every byte, so non-UTF-8 content is never corrupted; all patterns are ASCII.
    let text = content.toString("latin1");
    for (const re of full) text = text.replace(re, REDACTION_MARKER);
    for (const re of PREFIXED_PATTERNS) text = text.replace(re, `$1${REDACTION_MARKER}`);
    return Buffer.from(text, "latin1");
  };
}

export const defaultRedactor: Redactor = createSecretRedactor();
