/**
 * `untrusted_external_text` for the CI-failure trigger (T15.3; FR-QUE-03, LLD §18.6 step 3, ADR-0050 item 4). An
 * operator-forwarded notification summary is normalised, redacted, capped at 500 characters and labelled. It never
 * decides anything: the trigger enqueues only on a failing conclusion from the `CiStatusPort`. It reaches a fix-up
 * objective only through the template token `{{ci_untrusted_summary}}`, inside a labelled block it cannot close.
 */
import { defaultRedactor } from "../artifacts/redact.js";

/** LLD §18.6 `untrusted_summary` maximum. */
export const UNTRUSTED_SUMMARY_MAX = 500;
export const UNTRUSTED_EXTERNAL_LABEL = "untrusted_external_text";
export const CI_SUMMARY_TOKEN = "{{ci_untrusted_summary}}";

export interface UntrustedExternalText {
  readonly text: string;
  readonly label: typeof UNTRUSTED_EXTERNAL_LABEL;
}

const OPEN = `[${UNTRUSTED_EXTERNAL_LABEL}]`;
const CLOSE = `[/${UNTRUSTED_EXTERNAL_LABEL}]`;

/** NFC, control characters (NUL included) removed, token-shaped substrings redacted, trimmed, capped with an ellipsis. */
export function untrustedExternalText(raw: string): UntrustedExternalText {
  let text = raw.normalize("NFC");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
  text = defaultRedactor(Buffer.from(text, "utf8")).toString("utf8");
  // The block markers cannot appear inside the block.
  text = text.replaceAll(OPEN, "[untrusted]").replaceAll(CLOSE, "[/untrusted]").trim();
  if (text.length > UNTRUSTED_SUMMARY_MAX) {
    let cut = UNTRUSTED_SUMMARY_MAX - 1;
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    text = `${text.slice(0, cut)}…`;
  }
  return { text, label: UNTRUSTED_EXTERNAL_LABEL };
}

/** The labelled block substituted for {@link CI_SUMMARY_TOKEN}. */
export function untrustedBlock(t: UntrustedExternalText): string {
  return `${OPEN}\n${t.text}\n${CLOSE}`;
}

/** Trusted, controller-supplied facts a template may reference. */
export interface CiTemplateFacts {
  readonly publishRef: string;
  readonly headSha: string;
  readonly conclusion: string;
  readonly externalId: string;
}

/**
 * The fix-up objective: `{{ci_publish_ref}}`, `{{ci_head_sha}}`, `{{ci_conclusion}}` and `{{ci_external_id}}` take
 * controller facts; {@link CI_SUMMARY_TOKEN} takes the labelled summary, or an empty string when there is none. Without
 * the token no external text is copied. Substitution is one pass, so substituted text is never re-expanded.
 */
export function renderCiObjective(
  template: string,
  facts: CiTemplateFacts,
  summary: UntrustedExternalText | undefined,
): string {
  const values: Record<string, string> = {
    "{{ci_publish_ref}}": facts.publishRef,
    "{{ci_head_sha}}": facts.headSha,
    "{{ci_conclusion}}": facts.conclusion,
    "{{ci_external_id}}": facts.externalId,
    [CI_SUMMARY_TOKEN]: summary === undefined ? "" : untrustedBlock(summary),
  };
  return template.replace(/\{\{ci_[a-z_]+\}\}/gu, (m) => values[m] ?? m);
}
