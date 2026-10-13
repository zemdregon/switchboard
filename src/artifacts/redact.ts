/** A redaction function maps content to content with secrets removed. It must be deterministic (same input, same output). */
export type Redactor = (content: Buffer) => Buffer;

export const REDACTION_MARKER = "[REDACTED]";

/**
 * Default secret patterns (FR-TEL-03, NFR-SEC-01, TDD §3.3 layer 3). Proposed: a best-effort safety net for common token
 * shapes, not a guarantee; the primary control is never routing credentials into artifacts at all.
 */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (whole block, or an unterminated header through the end of input).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  // GitHub tokens (classic prefixed and fine-grained).
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  // `sk-` style API keys (includes sk-ant-..., sk-proj-...).
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Switchboard's own per-run tool-channel token (T9.4, `src/git/tool-protocol.ts`): prefix plus 43 base64url characters.
  /sbt1_[A-Za-z0-9_-]{43}/g,
];

/** Patterns that keep a prefix (the header or key name) and replace only the secret value. */
export const PREFIXED_PATTERNS: readonly RegExp[] = [
  // Authorization: Bearer <token> / Basic <token>, and bare "Bearer <token>".
  /(\bBearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value or "key": "value" for credential-looking names.
  /(\b(?:aws_secret_access_key|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)["']?[ \t]*[:=][ \t]*["']?)[^\s"',;]{8,}/gi,
];

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
