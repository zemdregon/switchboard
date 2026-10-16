/**
 * Consent-page approval link (T14.10; FR-CTL-09, FR-MCP-17, ADR-0041, ADR-0047 Decision 3, LLD §3.4.11). The secondary
 * way to decide a pending approval, after the CLI and the T14.8 approval proxy: a single-use, expiring link to the M13
 * consent page that names one approval by an opaque handle. This module owns the handles and the decision; the page
 * itself is `./consent-link-page.ts`.
 *
 * The handle is not a credential. It only selects which pending approval the operator is shown after they have
 * authenticated on the consent page with the passphrase or a pairing code (FR-MCP-17); holding it decides nothing.
 * The link carries no OAuth token, no `approval_digest`, no passphrase, no pairing code and no scope text.
 *
 * Delegated (not owner-approved; recorded in LLD §3.4.11):
 * - Handles live in memory only, hashed (SHA-256), like the authorization codes of `src/mcp/oauth-server.ts`: one
 *   `serve` process owns the listener, and a restart drops every link (fail closed; the next sweep issues new ones). No
 *   ledger table is added.
 * - A handle is `sbal_` plus 32 random bytes in base64url. It expires after {@link CONSENT_LINK_TTL_MS} (Assumption) or
 *   at its first decision, whichever is first, and is dead as soon as its approval is decided another way, stops being
 *   decidable or changes (its `approval_digest`, LLD §3.4.8, is recomputed from the ledger and compared on every use).
 *   A pending approval whose link expired gets a new handle at the next sweep; the old one stays dead.
 * - Which approvals: every one the approval proxy would list for a proxy that targets every configured client (read-only
 *   reuse of `createApprovalProxy(...).list`), so the closed summary, digest and kind rules are those of LLD §3.4.8.
 * - Recording: as the proxy records a decision, with `requested_by` / `decided_by` {@link CONSENT_PAGE_DECIDER}. The
 *   digest is checked again inside the decision's `BEGIN IMMEDIATE` transaction; any mismatch writes nothing.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ResolvedMcpClient } from "../config/index.js";
import type { Ledger, RunState } from "../ledger/index.js";
import { ApprovalRefusedError, type DecisionToApply, OPERATOR_DECISION_REQUESTED } from "../lifecycle/approval.js";
import type { DynamicProjectStore } from "../projects/index.js";
import { ProjectStoreError } from "../projects/index.js";
import { type ApprovalAnnouncement, type ApprovalProxyItem, createApprovalProxy } from "./approval-proxy.js";
import { NO_PROJECT_ID } from "./sinks.js";

/** `decided_by` of a decision made on the consent page (LLD §3.4.11). */
export const CONSENT_PAGE_DECIDER = "consent_page";
/** Path prefix of a link on the issuer origin; the handle is the only segment after it. */
export const CONSENT_LINK_PATH = "/approval/";
/** Link lifetime (Assumption): long enough to reach a phone, short enough that a forwarded link goes stale. */
export const CONSENT_LINK_TTL_MS = 30 * 60 * 1000;
/** Live links held at most (Assumption); a sweep issues no more until some expire or are used. */
export const MAX_CONSENT_LINKS = 256;
export const CONSENT_LINK_HANDLE_PATTERN = /^sbal_[A-Za-z0-9_-]{43}$/;

/** A refused consent-page decision. Nothing was written. */
export class ConsentLinkRefusedError extends Error {
  override readonly name = "ConsentLinkRefusedError";
}

/** The approvals the consent page may show and decide, and the decision itself. */
export interface ConsentApprovalSource {
  /** Every decidable approval, with its controller-generated fields and current digest. Reads only. */
  pending(): ApprovalProxyItem[];
  /** The decidable approval `approvalId`, or undefined. Reads only. */
  find(approvalId: string): ApprovalProxyItem | undefined;
  /** Decide it if it is still decidable with exactly `digest`; else throw {@link ConsentLinkRefusedError}. */
  decide(approvalId: string, digest: string, decision: "approve" | "deny"): "APPROVED" | "DENIED";
}

export interface ConsentApprovalSourceDeps {
  /** The ledger; the project store must use the same database connection (one decision transaction). */
  readonly ledger: Ledger;
  /** Every configured MCP client id: the approvals of all of them are the operator's to decide. */
  readonly clientIds: readonly string[];
  readonly projectStore?: DynamicProjectStore;
  /** The lifecycle's `applyApprovalDecision`. Runs in our transaction. */
  readonly applyDecision: (req: DecisionToApply) => RunState;
  /** Sink announcement for the decisions the transition hook does not announce. Must not throw. */
  readonly announce?: (a: ApprovalAnnouncement) => void;
}

const REFUSED = "the approval is no longer pending or has changed; nothing changed";

function sameHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function createConsentApprovalSource(deps: ConsentApprovalSourceDeps): ConsentApprovalSource {
  const { ledger } = deps;
  // Read-only reuse of the proxy's listing: an operator-side "proxy" that targets every configured client. Its decide
  // is never called; decisions below are recorded as the consent page's own.
  const ids = [...new Set(deps.clientIds)];
  const operatorView: ResolvedMcpClient = {
    id: CONSENT_PAGE_DECIDER,
    maxTrustProfile: "inspect-untrusted",
    approvalProxy: ids.length > 0,
    ...(ids.length > 0 ? { approvalProxyTargets: ids } : {}),
  };
  const lister = createApprovalProxy({
    ledger,
    clientId: CONSENT_PAGE_DECIDER,
    client: operatorView,
    ...(deps.projectStore !== undefined ? { projectStore: deps.projectStore } : {}),
    applyDecision: () => {
      throw new Error("not used");
    },
  });
  const pending = (): ApprovalProxyItem[] => lister.list({}).approvals;
  const find = (approvalId: string): ApprovalProxyItem | undefined =>
    pending().find((i) => i.approval_id === approvalId);

  return {
    pending,
    find,
    decide(approvalId, digest, input) {
      const decision = input === "approve" ? "APPROVED" : "DENIED";
      let announcement: ApprovalAnnouncement | undefined;
      ledger.immediate(() => {
        const item = find(approvalId);
        if (item === undefined || !sameHex(item.approval_digest, digest)) throw new ConsentLinkRefusedError(REFUSED);
        if (item.kind === "privileged_scope") {
          const row = ledger.getApproval(approvalId);
          const runId = item.run_id;
          if (row === undefined || runId === undefined) throw new ConsentLinkRefusedError(REFUSED);
          const event = ledger.appendRunEvent({
            runId,
            type: OPERATOR_DECISION_REQUESTED,
            payload: { decision, approval_id: row.id, requested_by: CONSENT_PAGE_DECIDER, scope_hash: row.scope_hash },
          });
          try {
            deps.applyDecision({
              requestEventId: event.id,
              runId,
              decision,
              requestedBy: CONSENT_PAGE_DECIDER,
              requestedAt: event.ts,
              scopeHash: row.scope_hash,
            });
          } catch (err) {
            // Rolls back the request event too: a refused decision writes nothing.
            if (err instanceof ApprovalRefusedError) throw new ConsentLinkRefusedError(REFUSED);
            throw err;
          }
          // An approve is announced by the lifecycle's transition hook (T3), as for the CLI and the proxy.
          if (decision === "DENIED") {
            announcement = { projectId: item.project_id ?? NO_PROJECT_ID, kind: item.kind, runId };
          }
          return;
        }
        const store = deps.projectStore;
        if (store === undefined || item.project_id === undefined || item.revision === undefined) {
          throw new ConsentLinkRefusedError(REFUSED);
        }
        try {
          store.decide({
            projectId: item.project_id,
            revision: item.revision,
            decision: decision === "APPROVED" ? "APPROVED" : "REJECTED",
            decidedBy: CONSENT_PAGE_DECIDER,
          });
        } catch (err) {
          if (err instanceof ProjectStoreError) throw new ConsentLinkRefusedError(REFUSED);
          throw err;
        }
        announcement = { projectId: item.project_id, kind: item.kind, runId: null };
      });
      if (announcement !== undefined) {
        try {
          deps.announce?.(announcement);
        } catch {
          // Best effort (ADR-0048 item 6): an announcement never changes the decision.
        }
      }
      return decision;
    },
  };
}

/** A link handed to the operator. `url` is the only thing to show; it is not a credential. */
export interface IssuedConsentLink {
  readonly approvalId: string;
  readonly url: string;
  readonly expiresAt: string;
}

interface LinkEntry {
  readonly approvalId: string;
  /** The `approval_digest` when issued: the link dies when the approval changes. */
  readonly digest: string;
  readonly expiresAt: number;
  used: boolean;
}

export interface ConsentLinkStoreOptions {
  readonly source: ConsentApprovalSource;
  /** The authorization server's issuer (the origin of `transport.http.public_url`); links point at its origin. */
  readonly issuer: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly randomBytes?: (n: number) => Buffer;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** The handle of a link path, or undefined when the path is not a well-formed link. */
export function consentLinkHandle(pathname: string): string | undefined {
  if (!pathname.startsWith(CONSENT_LINK_PATH)) return undefined;
  const handle = pathname.slice(CONSENT_LINK_PATH.length);
  return CONSENT_LINK_HANDLE_PATTERN.test(handle) ? handle : undefined;
}

/** Single-use, expiring handles for pending approvals. In memory: one `serve` process owns the listener. */
export class ConsentLinkStore {
  private readonly links = new Map<string, LinkEntry>();
  private readonly origin: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;

  constructor(private readonly opts: ConsentLinkStoreOptions) {
    this.origin = new URL(opts.issuer).origin;
    this.ttlMs = opts.ttlMs ?? CONSENT_LINK_TTL_MS;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.randomBytes ?? randomBytes;
  }

  get size(): number {
    return this.links.size;
  }

  /** Drop used, expired and dead links (their approval decided, gone or changed). */
  private prune(now: number, live: ReadonlyMap<string, ApprovalProxyItem>): void {
    for (const [k, v] of this.links) {
      const item = live.get(v.approvalId);
      if (v.used || v.expiresAt <= now || item === undefined || !sameHex(item.approval_digest, v.digest)) {
        this.links.delete(k);
      }
    }
  }

  private mint(item: ApprovalProxyItem, now: number): IssuedConsentLink {
    const bytes = this.random(32);
    if (bytes.length !== 32) throw new Error("entropy source returned the wrong length");
    const handle = `sbal_${bytes.toString("base64url")}`;
    const expiresAt = now + this.ttlMs;
    this.links.set(sha256(handle), {
      approvalId: item.approval_id,
      digest: item.approval_digest,
      expiresAt,
      used: false,
    });
    return {
      approvalId: item.approval_id,
      url: `${this.origin}${CONSENT_LINK_PATH}${handle}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** A new link for one decidable approval, or undefined when it is not decidable or the store is full. */
  issue(approvalId: string): IssuedConsentLink | undefined {
    const now = this.now().getTime();
    const items = new Map(this.opts.source.pending().map((i) => [i.approval_id, i]));
    this.prune(now, items);
    const item = items.get(approvalId);
    if (item === undefined || this.links.size >= MAX_CONSENT_LINKS) return undefined;
    return this.mint(item, now);
  }

  /** Issue a link for every decidable approval that has no live one; returns only the new links. */
  sweep(): IssuedConsentLink[] {
    const now = this.now().getTime();
    const pending = this.opts.source.pending();
    this.prune(now, new Map(pending.map((i) => [i.approval_id, i])));
    const covered = new Set([...this.links.values()].map((v) => v.approvalId));
    const out: IssuedConsentLink[] = [];
    for (const item of pending) {
      if (covered.has(item.approval_id)) continue;
      if (this.links.size >= MAX_CONSENT_LINKS) break;
      out.push(this.mint(item, now));
    }
    return out;
  }

  private live(handle: string): { key: string; entry: LinkEntry; item: ApprovalProxyItem } | undefined {
    if (!CONSENT_LINK_HANDLE_PATTERN.test(handle)) return undefined;
    const key = sha256(handle);
    const entry = this.links.get(key);
    if (entry === undefined) return undefined;
    if (entry.used || this.now().getTime() >= entry.expiresAt) {
      this.links.delete(key);
      return undefined;
    }
    const item = this.opts.source.find(entry.approvalId);
    if (item === undefined || !sameHex(item.approval_digest, entry.digest)) {
      this.links.delete(key); // decided another way, no longer decidable, or changed: revoked
      return undefined;
    }
    return { key, entry, item };
  }

  /** The approval a live link names, for the authenticated page. Reads only; undefined for any dead or unknown link. */
  resolve(handle: string): ApprovalProxyItem | undefined {
    return this.live(handle)?.item;
  }

  /**
   * Spend the link and decide its approval. The link is used up whatever the outcome, so a second submission never
   * decides anything. Throws {@link ConsentLinkRefusedError} (nothing written) for a dead link or a refused decision.
   */
  redeem(handle: string, decision: "approve" | "deny"): { approvalId: string; status: "APPROVED" | "DENIED" } {
    const found = this.live(handle);
    if (found === undefined) throw new ConsentLinkRefusedError("this approval link is no longer valid");
    found.entry.used = true;
    this.links.delete(found.key);
    const status = this.opts.source.decide(found.entry.approvalId, found.entry.digest, decision);
    return { approvalId: found.entry.approvalId, status };
  }
}
