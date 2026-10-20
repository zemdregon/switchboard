/**
 * HTML for the embedded authorization server's consent page (T13.8; ADR-0041 item 3, LLD §3.3, Q-76).
 *
 * The page is static markup with no script, style or external resource. Every interpolated value is HTML-escaped,
 * including the client name a registering client chose. Headers forbid framing (CSP `frame-ancestors 'none'` and
 * `X-Frame-Options: DENY`), caching and referrers, and limit form submission to this origin; the authorization
 * response's redirect target is added to `form-action` because browsers apply it to the redirect after a submission.
 */
import type { ServerResponse } from "node:http";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Security headers for every consent-page response (HTML or redirect). */
export function consentHeaders(formActionOrigin?: string): Record<string, string> {
  const formAction = formActionOrigin ? `'self' ${formActionOrigin}` : "'self'";
  return {
    "content-security-policy": `default-src 'none'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    pragma: "no-cache",
    "cross-origin-opener-policy": "same-origin",
  };
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
  `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    ...consentHeaders(),
    ...headers,
  });
  res.end(res.req.method === "HEAD" ? undefined : html);
}

/** A terminal error page: nothing to submit, no redirect. The message is a fixed string, never request input. */
export function errorPage(message: string): string {
  return page("Switchboard authorization", `<p>${escapeHtml(message)}</p>`);
}

export interface ConsentView {
  readonly requestId: string;
  readonly csrf: string;
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** True while the client is `pending`: approving also approves the client (ADR-0041 item 3). */
  readonly newClient: boolean;
  /** A fixed notice such as "Wrong passphrase or pairing code." */
  readonly notice?: string;
  /**
   * T13.11 (FR-MCP-19): the host of the Client Identifier URL when the client identified itself with a Client ID
   * Metadata Document. Shown on its own line, since the host is the one fact about such a client that the client's
   * own document cannot choose (the draft's §8.5).
   */
  readonly metadataHost?: string;
}

export function consentPage(v: ConsentView): string {
  const name = v.clientName ?? "(unnamed client)";
  const nameSource = v.metadataHost !== undefined ? "from the client's metadata document" : "chosen by the client";
  const body =
    (v.notice ? `<p role="alert"><strong>${escapeHtml(v.notice)}</strong></p>` : "") +
    (v.newClient
      ? "<p>A new client asks to be approved. Approve it only if you started this sign-in yourself.</p>"
      : "<p>An approved client asks for a new authorization.</p>") +
    "<dl>" +
    (v.metadataHost !== undefined
      ? `<dt>Client metadata document host</dt><dd><code>${escapeHtml(v.metadataHost)}</code></dd>`
      : "") +
    `<dt>Client name (${nameSource})</dt><dd>${escapeHtml(name)}</dd>` +
    `<dt>Client id</dt><dd><code>${escapeHtml(v.clientId)}</code></dd>` +
    `<dt>Returns to</dt><dd><code>${escapeHtml(v.redirectUri)}</code></dd>` +
    `<dt>Scope</dt><dd><code>${escapeHtml(v.scopes.join(" "))}</code></dd>` +
    "</dl>" +
    '<form method="post" action="/authorize">' +
    `<input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">` +
    '<p><label>Operator passphrase <input type="password" name="passphrase" autocomplete="current-password">' +
    "</label></p>" +
    '<p><label>or one-time pairing code (<code>switchboard consent pair</code>) <input type="text" name="pairing_code" ' +
    'autocomplete="off" spellcheck="false"></label></p>' +
    '<p><button type="submit" name="decision" value="approve">Approve</button> ' +
    '<button type="submit" name="decision" value="deny">Deny</button></p>' +
    "</form>";
  return page("Authorize a client for Switchboard", body);
}
