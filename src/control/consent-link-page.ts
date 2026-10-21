/**
 * The consent page's approval-link flow (T14.10; FR-CTL-09, FR-MCP-17, ADR-0041 item 3, ADR-0047 Decision 3, LLD
 * §3.3 and §3.4.11). Served on the issuer origin at `/approval/<handle>` (`./consent-link.ts`) beside the OAuth client
 * consent of `src/mcp/oauth-server.ts`, with the same markup rules, security headers and authentication.
 *
 * Flow, three steps, each a fresh form:
 * 1. `GET /approval/<anything>` shows one fixed sign-in form, the same for a live, used, expired, unknown or malformed
 *    handle, so the page tells an unauthenticated visitor nothing, not even whether the link is valid, and shows no
 *    approval field at all.
 * 2. `POST` with the operator passphrase or a one-time pairing code (FR-MCP-17; there is no login session, Q-76). Only
 *    after that succeeds is the link looked up; a dead link then gets a fixed error, and a live one the approval's
 *    controller-generated fields (the closed `approval_proxy_item` fields of LLD §3.4.8 without the digest) and the
 *    Approve and Deny buttons.
 * 3. `POST` with the decision spends the link (`ConsentLinkStore.redeem`) whatever the outcome.
 *
 * CSRF (as T13.8): each step has a random visit id and a CSRF token held server-side, the form carries both, the token
 * is also a `__Host-` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`), and a POST must match both, carry no foreign
 * `Origin` and no cross-site `Sec-Fetch-Site`. A visit is bound to the hash of its link's handle, so a form from one
 * link cannot decide another. A mismatch ends the visit.
 *
 * Attempt limits: wrong passphrases count against the `AttemptLimiter` `serve` shares with the OAuth consent page, so
 * this page adds no guesses; wrong pairing codes are throttled as there. Wrong codes and passphrases also count against
 * the per-address `IpAttemptLimiter` `serve` shares with the OAuth consent page (an address over its limit gets 429).
 * Only a legacy unbound code (`switchboard consent pair`) signs in here: a profile-bound code issued by `switchboard mcp
 * oauth issue-code` to approve a remote OAuth client never decides an approval (`PairingCodeStore.redeem`). Nothing
 * secret reaches `onEvent`: event names, approval ids (after authentication only), methods and reason codes.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mediaType, readBody } from "../mcp/http-body.js";
import { errorPage, escapeHtml, sendHtml } from "../mcp/oauth-consent-page.js";
import { IP_LOCK_MS, IpAttemptLimiter } from "../mcp/oauth-ip-limiter.js";
import type { PairingCodeStore } from "../mcp/oauth-pairing.js";
import { verifyPassphrase as defaultVerifyPassphrase } from "../mcp/oauth-passphrase.js";
import { AttemptLimiter, cookie, LOCKOUT_MS, MAX_PAIRING_FAILURES_PER_MINUTE, parseForm } from "../mcp/oauth-server.js";
import type { ApprovalProxyItem } from "./approval-proxy.js";
import { CONSENT_LINK_PATH, ConsentLinkRefusedError, type ConsentLinkStore } from "./consent-link.js";

export const APPROVAL_LINK_COOKIE = "__Host-sb_approval";
/** Lifetime of one step's form (Assumption): the operator signs in, reads and decides within it. */
export const APPROVAL_VISIT_TTL_MS = 10 * 60 * 1000;
export const MAX_APPROVAL_VISITS = 32;
const PAIRING_WINDOW_MS = 60 * 1000;
const MAX_FORM_BYTES = 8 * 1024;

export type ApprovalLinkEvent =
  | "approval_link_shown"
  | "approval_link_authenticated"
  | "approval_link_dead"
  | "approval_link_decided"
  | "approval_link_refused"
  | "approval_link_failed"
  | "approval_link_locked"
  | "approval_link_csrf_refused";

/** Audit fields: never a handle, URL, passphrase or pairing code. */
export type ApprovalLinkEventFields = {
  approval_id?: string;
  method?: "passphrase" | "pairing_code";
  decision?: "APPROVED" | "DENIED";
  reason?: string;
};

export interface ApprovalLinkPageDeps {
  /** The issuer origin (`transport.http` issuer). */
  readonly issuer: string;
  readonly links: Pick<ConsentLinkStore, "resolve" | "redeem">;
  readonly pairing?: Pick<PairingCodeStore, "redeem">;
  readonly passphraseHash?: string;
  readonly verifyPassphrase?: (passphrase: string, encoded: string) => Promise<boolean>;
  /** Shared with the OAuth consent page; a fresh one when absent. */
  readonly limiter?: AttemptLimiter;
  /** Per-address lockout, shared with the OAuth consent page; a fresh one (socket peer only) when absent. */
  readonly ipLimiter?: IpAttemptLimiter;
  readonly now?: () => Date;
  readonly randomBytes?: (n: number) => Buffer;
  readonly onEvent?: (event: ApprovalLinkEvent, fields: ApprovalLinkEventFields) => void;
}

interface Visit {
  readonly handleHash: Buffer;
  readonly csrfHash: Buffer;
  readonly stage: "authenticate" | "decide";
  readonly expiresAt: number;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function sameSecret(a: string | undefined, expectedHash: Buffer): boolean {
  return a !== undefined && timingSafeEqual(sha256(a), expectedHash);
}

const TITLE = "Switchboard approval";

function page(body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title></head>` +
    `<body><h1>${TITLE}</h1>${body}</body></html>`
  );
}

const hidden = (name: string, value: string): string =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

/** Step 1: the same form for every handle. No approval field. */
export function signInPage(action: string, visitId: string, csrf: string, notice?: string): string {
  return page(
    (notice ? `<p role="alert"><strong>${escapeHtml(notice)}</strong></p>` : "") +
      "<p>Sign in to see and decide the approval this link names.</p>" +
      `<form method="post" action="${escapeHtml(action)}">` +
      hidden("visit_id", visitId) +
      hidden("csrf", csrf) +
      '<p><label>Operator passphrase <input type="password" name="passphrase" autocomplete="current-password">' +
      "</label></p>" +
      '<p><label>or one-time pairing code (<code>switchboard consent pair</code>) <input type="text" ' +
      'name="pairing_code" autocomplete="off" spellcheck="false"></label></p>' +
      '<p><button type="submit" name="step" value="authenticate">Continue</button></p>' +
      "</form>",
  );
}

/** Step 2: the approval's controller-generated fields and the decision buttons. */
export function decisionPage(action: string, visitId: string, csrf: string, item: ApprovalProxyItem): string {
  const rows: [string, string | number | undefined][] = [
    ["Kind", item.kind],
    ["Approval id", item.approval_id],
    ["Project", item.project_id],
    ["Run", item.run_id],
    ["Revision", item.revision],
    ["Requested by client", item.target_client_id],
    ["Summary", item.scope_summary],
    ["Requested at", item.requested_at],
  ];
  return page(
    "<p>A pending approval waits for your decision. Approve it only if you expected it.</p><dl>" +
      rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `<dt>${k}</dt><dd><code>${escapeHtml(String(v))}</code></dd>`)
        .join("") +
      "</dl>" +
      `<form method="post" action="${escapeHtml(action)}">` +
      hidden("visit_id", visitId) +
      hidden("csrf", csrf) +
      '<p><button type="submit" name="step" value="approve">Approve</button> ' +
      '<button type="submit" name="step" value="deny">Deny</button></p>' +
      "</form>",
  );
}

export class ApprovalLinkPage {
  private readonly visits = new Map<string, Visit>();
  private readonly limiter: AttemptLimiter;
  private readonly ipLimiter: IpAttemptLimiter;
  private pairingFailures: number[] = [];
  private verifying = false;
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;
  private readonly checkPassphrase: (passphrase: string, encoded: string) => Promise<boolean>;

  constructor(private readonly deps: ApprovalLinkPageDeps) {
    this.limiter = deps.limiter ?? new AttemptLimiter();
    this.ipLimiter = deps.ipLimiter ?? new IpAttemptLimiter();
    this.now = deps.now ?? (() => new Date());
    this.random = deps.randomBytes ?? randomBytes;
    this.checkPassphrase = deps.verifyPassphrase ?? defaultVerifyPassphrase;
  }

  private event(event: ApprovalLinkEvent, fields: ApprovalLinkEventFields = {}): void {
    this.deps.onEvent?.(event, fields);
  }

  private secret(): string {
    const bytes = this.random(32);
    if (bytes.length !== 32) throw new Error("entropy source returned the wrong length");
    return bytes.toString("base64url");
  }

  private prune(now: number): void {
    for (const [k, v] of this.visits) if (v.expiresAt <= now) this.visits.delete(k);
    this.pairingFailures = this.pairingFailures.filter((t) => now - t < PAIRING_WINDOW_MS);
  }

  /** Open a visit and send its form with a fresh CSRF cookie. */
  private open(
    res: ServerResponse,
    status: number,
    handle: string,
    stage: Visit["stage"],
    render: (visitId: string, csrf: string) => string,
  ): void {
    const now = this.now().getTime();
    this.prune(now);
    while (this.visits.size >= MAX_APPROVAL_VISITS) {
      const oldest = this.visits.keys().next().value;
      if (oldest === undefined) break;
      this.visits.delete(oldest);
    }
    const visitId = this.secret();
    const csrf = this.secret();
    this.visits.set(visitId, {
      handleHash: sha256(handle),
      csrfHash: sha256(csrf),
      stage,
      expiresAt: now + APPROVAL_VISIT_TTL_MS,
    });
    sendHtml(res, status, render(visitId, csrf), {
      "set-cookie": `${APPROVAL_LINK_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${APPROVAL_VISIT_TTL_MS / 1000}`,
    });
  }

  /** `GET`/`HEAD`/`POST /approval/<handle>`; `pathname` is the request's path. */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!pathname.startsWith(CONSENT_LINK_PATH)) {
      sendHtml(res, 404, errorPage("Not found."));
      return;
    }
    // The raw path segment, valid or not: the response must not depend on it before authentication.
    const handle = pathname.slice(CONSENT_LINK_PATH.length);
    const action = pathname;
    if (req.method === "GET" || req.method === "HEAD") {
      this.event("approval_link_shown");
      this.open(res, 200, handle, "authenticate", (v, c) => signInPage(action, v, c));
      return;
    }
    if (req.method !== "POST") {
      sendHtml(res, 405, errorPage("Method not allowed."), { allow: "GET, HEAD, POST" });
      return;
    }
    await this.post(req, res, handle, action);
  }

  private async post(req: IncomingMessage, res: ServerResponse, handle: string, action: string): Promise<void> {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if ((origin !== undefined && origin !== this.deps.issuer) || (site !== undefined && site !== "same-origin")) {
      this.event("approval_link_csrf_refused", { reason: "cross_site" });
      sendHtml(res, 403, errorPage("This form can only be submitted from the consent page."));
      return;
    }
    if (mediaType(req) !== "application/x-www-form-urlencoded") {
      sendHtml(res, 415, errorPage("Unsupported form encoding."));
      return;
    }
    const read = await readBody(req, MAX_FORM_BYTES);
    const form = read.ok ? parseForm(read.body.toString("utf8")) : undefined;
    if (form === undefined) {
      sendHtml(res, 400, errorPage("Invalid form."));
      return;
    }
    const now = this.now().getTime();
    this.prune(now);
    const clearCookie = {
      "set-cookie": `${APPROVAL_LINK_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
    };
    const visitId = form.get("visit_id");
    const visit = visitId !== undefined ? this.visits.get(visitId) : undefined;
    if (visitId === undefined || visit === undefined) {
      sendHtml(res, 400, errorPage("This page has expired. Open the approval link again."), clearCookie);
      return;
    }
    // Every visit is single-use: a later step gets a new one.
    this.visits.delete(visitId);
    if (
      !sameSecret(form.get("csrf"), visit.csrfHash) ||
      !sameSecret(cookie(req, APPROVAL_LINK_COOKIE), visit.csrfHash) ||
      !timingSafeEqual(sha256(handle), visit.handleHash)
    ) {
      this.event("approval_link_csrf_refused", { reason: "csrf_token" });
      sendHtml(res, 403, errorPage("The form could not be verified. Open the approval link again."), clearCookie);
      return;
    }
    const step = form.get("step");
    if (visit.stage === "decide") {
      if (step !== "approve" && step !== "deny") {
        sendHtml(res, 400, errorPage("Invalid form."), clearCookie);
        return;
      }
      try {
        const r = this.deps.links.redeem(handle, step);
        this.event("approval_link_decided", { approval_id: r.approvalId, decision: r.status });
        sendHtml(
          res,
          200,
          errorPage(r.status === "APPROVED" ? "The approval was approved." : "The approval was denied."),
          clearCookie,
        );
      } catch (err) {
        if (!(err instanceof ConsentLinkRefusedError)) throw err;
        this.event("approval_link_refused", { reason: "not_decidable" });
        sendHtml(res, 410, errorPage("This approval link is no longer valid. Nothing changed."), clearCookie);
      }
      return;
    }
    // Stage "authenticate". Any other step (a forged "approve" included) is not a decision here.
    const retry = (status: number, notice: string) =>
      this.open(res, status, handle, "authenticate", (v, c) => signInPage(action, v, c, notice));
    if (step !== "authenticate") {
      retry(400, "Enter the operator passphrase or a pairing code.");
      return;
    }
    const passphrase = form.get("passphrase") ?? "";
    const pairingCode = form.get("pairing_code") ?? "";
    const { key: ipKey } = this.ipLimiter.identify(req);
    const ipLockedOut = () =>
      sendHtml(res, 429, errorPage("Too many wrong attempts from this address. Try again later."), {
        ...clearCookie,
        "retry-after": String(IP_LOCK_MS / 1000),
      });
    if ((passphrase !== "" || pairingCode !== "") && this.ipLimiter.locked(ipKey, now)) {
      this.event("approval_link_locked", { reason: "address" });
      ipLockedOut();
      return;
    }
    if (passphrase !== "" && this.limiter.locked(now)) {
      this.event("approval_link_locked", { method: "passphrase" });
      sendHtml(res, 429, errorPage("Too many wrong passphrases. Passphrase approval is locked; try again later."), {
        ...clearCookie,
        "retry-after": String(LOCKOUT_MS / 1000),
      });
      return;
    }
    if (passphrase === "" && pairingCode !== "" && this.pairingFailures.length >= MAX_PAIRING_FAILURES_PER_MINUTE) {
      this.event("approval_link_locked", { method: "pairing_code" });
      retry(429, "Too many wrong pairing codes. Wait a minute and try again.");
      return;
    }
    if (passphrase === "" && pairingCode === "") {
      retry(400, "Enter the operator passphrase or a pairing code.");
      return;
    }
    const method = passphrase !== "" ? "passphrase" : "pairing_code";
    let ok: boolean;
    if (method === "passphrase") {
      if (this.verifying) {
        retry(429, "Another sign-in is being checked. Try again.");
        return;
      }
      this.verifying = true;
      try {
        const hash = this.deps.passphraseHash;
        ok = hash !== undefined && (await this.checkPassphrase(passphrase, hash));
      } finally {
        this.verifying = false;
      }
    } else {
      ok = this.deps.pairing?.redeem(pairingCode) ?? false;
    }
    const after = this.now().getTime();
    if (!ok) {
      this.event("approval_link_failed", { method });
      const ipLock = this.ipLimiter.fail(ipKey, after);
      if (method === "passphrase" && this.limiter.fail(after)) {
        sendHtml(res, 429, errorPage("Too many wrong passphrases. Passphrase approval is locked; try again later."), {
          ...clearCookie,
          "retry-after": String(LOCKOUT_MS / 1000),
        });
        return;
      }
      if (method === "pairing_code") this.pairingFailures.push(after);
      if (ipLock) {
        ipLockedOut();
        return;
      }
      retry(401, "Wrong passphrase or pairing code.");
      return;
    }
    if (method === "passphrase") this.limiter.succeed();
    // Authenticated: only now is the link looked up.
    const item = this.deps.links.resolve(handle);
    if (item === undefined) {
      this.event("approval_link_dead", { method });
      sendHtml(res, 410, errorPage("This approval link is no longer valid. Nothing changed."), clearCookie);
      return;
    }
    this.event("approval_link_authenticated", { approval_id: item.approval_id, method });
    this.open(res, 200, handle, "decide", (v, c) => decisionPage(action, v, c, item));
  }
}
