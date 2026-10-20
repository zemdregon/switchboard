/**
 * Client ID Metadata Documents for the embedded authorization server (T13.11; FR-MCP-19, LLD §20.11, ADR-0063,
 * `draft-ietf-oauth-client-id-metadata-document`).
 *
 * A client may identify itself with an `https` URL as its `client_id`; the JSON document at that URL holds its
 * RFC 7591 metadata. This module validates such an identifier, fetches the document under strict limits and checks
 * it. The fetch is the one place where the authorization server makes an outbound request to an address chosen by an
 * unauthenticated caller, so it is bounded on purpose (Delegated, fail closed; the limits follow LLD §20.11 and the
 * draft's §3, §5 and §8.6):
 *
 * - The identifier must be its own WHATWG serialisation: `https`, a host that is a DNS name (never an IP literal), a
 *   path other than `/`, no userinfo, query or fragment, at most {@link MAX_CIMD_CLIENT_ID_LENGTH} characters. The
 *   draft only recommends against `/` and a query; refusing both keeps the identifier unambiguous.
 * - The host is resolved here, once, and **every** resolved address must pass the {@link AddressPolicy}: by default
 *   nothing private, loopback, link-local, unique-local, unspecified, multicast, documentation or otherwise
 *   special-use, with IPv4-mapped IPv6, NAT64 (RFC 6052 well-known prefix), 6to4 and Teredo forms of a blocked IPv4
 *   range blocked too (Linus decision v10 (c)). The TLS connection is then pinned to the checked address with the
 *   server name set to the host, so a second resolution cannot swap the target (no TOCTOU re-resolve).
 * - One `GET`; the response must be `200` with a JSON media type. A redirect of any kind is refused (the draft's §5
 *   says the server MUST NOT follow one; LLD §20.11's "at most one" is tightened to none). The whole fetch, resolution
 *   included, ends after {@link CIMD_FETCH_TIMEOUT_MS}; a body over {@link CIMD_MAX_DOCUMENT_BYTES}, declared or
 *   received, is refused without being parsed.
 * - The document's `client_id` must equal the identifier by simple string comparison, and the rest is checked by the
 *   same {@link checkClientMetadata} as a registration request (public client, `https` redirect URIs only).
 * - At most {@link MAX_CIMD_FETCHES_IN_FLIGHT} fetches run at once; more are refused, so a flood of authorization
 *   requests cannot turn the server into a request amplifier.
 * - Nothing is cached across consents (Linus decision v10 (b)): every authorization request fetches afresh.
 *
 * The TLS trust store is Node's default. Tests inject a certificate authority through {@link CimdFetchDeps.ca} for a
 * local fixture; there is no switch that turns verification off.
 *
 * Inside Switchboard a CIMD client is keyed by {@link cimdInternalClientId}, a `sbc_` identifier derived from the URL,
 * so tokens, meta-session bindings and the `transport.http.clients` mapping keep the identifier form every table
 * checks; the URL itself is kept beside it (`oauth_cimd_client`, migration 0028) and shown to the operator.
 */
import { hash } from "node:crypto";
import type { LookupAddress, LookupOptions } from "node:dns";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { type ClientMetadata, checkClientMetadata } from "./oauth-clients.js";

export const CIMD_FETCH_TIMEOUT_MS = 5000;
export const CIMD_MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_CIMD_FETCHES_IN_FLIGHT = 2;
export const MAX_CIMD_CLIENT_ID_LENGTH = 2048;

/** True when a `client_id` has the shape of a Client Identifier URL, whether or not it is a valid one. */
export function looksLikeCimdClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * The parsed Client Identifier URL, or undefined when the identifier breaks a rule above. The identifier is compared
 * and fetched verbatim (the draft's simple string comparison), so it must equal its own serialisation.
 */
export function checkCimdClientId(clientId: string): URL | undefined {
  if (clientId.length === 0 || clientId.length > MAX_CIMD_CLIENT_ID_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.href !== clientId || url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "" || clientId.includes("?") || clientId.includes("#")) return undefined;
  if (url.pathname === "/" || url.pathname === "") return undefined;
  const host = url.hostname;
  if (host === "" || host.startsWith("[") || net.isIP(host) !== 0) return undefined;
  if (url.pathname.split("/").some((seg) => seg === "." || seg === "..")) return undefined;
  return url;
}

/**
 * The internal `sbc_` identifier of a CIMD client: 128 bits of the URL's SHA-256, base64url (22 characters). The input
 * is a public HTTPS URL, not a secret, so a fast digest is the right tool; a password hash would only slow the lookup.
 */
export function cimdInternalClientId(clientId: string): string {
  const digest = Buffer.from(hash("sha256", clientId, "hex"), "hex");
  return `sbc_${digest.subarray(0, 16).toString("base64url")}`;
}

/** Decides whether a resolved address may be connected to. */
export interface AddressPolicy {
  allows(address: string): boolean;
}

const blockedV4 = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (CGNAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (and cloud metadata endpoints)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including the limited broadcast address
] as const) {
  blockedV4.addSubnet(addr, bits, "ipv4");
}

const blockedV6 = new net.BlockList();
for (const [addr, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // NAT64 local-use prefix (RFC 8215): local by definition
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blockedV6.addSubnet(addr, bits, "ipv6");
}

/** The 16 bytes of an IPv6 address literal (a zone suffix is ignored), or undefined when it does not parse. */
function ipv6Bytes(address: string): Uint8Array | undefined {
  let text = address.split("%")[0] ?? "";
  if (!net.isIPv6(text)) return undefined;
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    // A trailing dotted quad (`::ffff:10.0.0.1`) becomes its two hex groups.
    if (!net.isIPv4(last)) return undefined;
    const q = last.split(".").map(Number);
    const hi = (((q[0] ?? 0) << 8) | (q[1] ?? 0)).toString(16);
    const lo = (((q[2] ?? 0) << 8) | (q[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const words = [...head, ...new Array<string>(missing).fill("0"), ...rest];
  if (words.length !== 8) return undefined;
  const out = new Uint8Array(16);
  for (const [i, w] of words.entries()) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return undefined;
    const n = Number.parseInt(w, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

const dotted = (b: Uint8Array, at: number): string => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/**
 * The IPv4 address embedded in an IPv6 transition form, if any: IPv4-mapped (`::ffff:a.b.c.d`), the NAT64 well-known
 * prefix `64:ff9b::/96` (RFC 6052), 6to4 `2002::/16` (RFC 3056) and Teredo `2001::/32` (RFC 4380, the client address
 * is stored inverted).
 */
export function embeddedIpv4(address: string): string | undefined {
  const b = ipv6Bytes(address);
  if (b === undefined) return undefined;
  const zero = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return dotted(b, 12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return dotted(b, 12);
  if (b[0] === 0x20 && b[1] === 0x02) return dotted(b, 2);
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    return `${(b[12] ?? 0) ^ 0xff}.${(b[13] ?? 0) ^ 0xff}.${(b[14] ?? 0) ^ 0xff}.${(b[15] ?? 0) ^ 0xff}`;
  }
  return undefined;
}

/** True when `address` is a special-use address the server must never fetch from (anything unparsable counts). */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address.split("%")[0] ?? "");
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family !== 6) return true;
  const bare = address.split("%")[0] ?? "";
  if (ipv6Bytes(bare) === undefined || blockedV6.check(bare, "ipv6")) return true;
  const v4 = embeddedIpv4(bare);
  return v4 !== undefined && blockedV4.check(v4, "ipv4");
}

export const DEFAULT_ADDRESS_POLICY: AddressPolicy = { allows: (address) => !isBlockedAddress(address) };

export type CimdRefusal =
  | "client_id"
  | "busy"
  | "dns"
  | "address_blocked"
  | "timeout"
  | "connect"
  | "redirect"
  | "status"
  | "content_type"
  | "too_large"
  | "json"
  | "client_id_mismatch"
  | "metadata";

export type CimdResult =
  | { ok: true; metadata: ClientMetadata; host: string }
  | { ok: false; reason: CimdRefusal; host?: string };

export interface CimdFetchDeps {
  /** Every address of a host (tests inject one; the default is `dns.promises.lookup` with `all: true`). */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Tests allow exactly their fixture's loopback address on top of the default policy. */
  addressPolicy?: AddressPolicy;
  /** Extra trusted certificate authorities for the fetch (tests only; never a switch that disables verification). */
  ca?: string | Buffer | (string | Buffer)[];
  timeoutMs?: number;
  maxBytes?: number;
}

type Fetched =
  | { ok: true; body: string }
  | { ok: false; reason: "timeout" | "connect" | "redirect" | "status" | "content_type" | "too_large" };

async function defaultLookup(hostname: string): Promise<string[]> {
  const found = await dns.promises.lookup(hostname, { all: true });
  return found.map((a) => a.address);
}

function jsonMediaType(contentType: string | undefined): boolean {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

/** One pinned `GET`: the socket goes to `address`, TLS verifies the certificate against `url.hostname`. */
function get(url: URL, address: string, signal: AbortSignal, deps: CimdFetchDeps): Promise<Fetched> {
  const maxBytes = deps.maxBytes ?? CIMD_MAX_DOCUMENT_BYTES;
  const family = net.isIP(address);
  const pinned = (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    if (hostname !== url.hostname) {
      callback(new Error("lookup for an unexpected host"), "", undefined);
      return;
    }
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Fetched) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const req = https.request(
      {
        host: url.hostname,
        servername: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "application/json", "user-agent": "Switchboard (client-id-metadata-document)" },
        lookup: pinned as unknown as net.LookupFunction,
        agent: false,
        signal,
        ...(deps.ca !== undefined ? { ca: deps.ca } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location !== undefined) {
          finish({ ok: false, reason: "redirect" });
          res.destroy();
          return;
        }
        if (status !== 200) {
          finish({ ok: false, reason: "status" });
          res.destroy();
          return;
        }
        if (!jsonMediaType(res.headers["content-type"])) {
          finish({ ok: false, reason: "content_type" });
          res.destroy();
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish({ ok: false, reason: "too_large" });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish({ ok: false, reason: "too_large" });
            res.destroy();
            return;
          }
          if (!done) chunks.push(chunk);
        });
        res.on("error", () => finish({ ok: false, reason: signal.aborted ? "timeout" : "connect" }));
        res.on("end", () => finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", () => finish({ ok: false, reason: signal.aborted ? "timeout" : "connect" }));
    req.end();
  });
}

/** Fetches and checks Client ID Metadata Documents; one instance per authorization server (it holds the fetch cap). */
export class CimdFetcher {
  private inFlight = 0;

  constructor(private readonly deps: CimdFetchDeps = {}) {}

  async fetch(clientId: string): Promise<CimdResult> {
    const url = checkCimdClientId(clientId);
    if (url === undefined) return { ok: false, reason: "client_id" };
    const host = url.host;
    if (this.inFlight >= MAX_CIMD_FETCHES_IN_FLIGHT) return { ok: false, reason: "busy", host };
    this.inFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? CIMD_FETCH_TIMEOUT_MS);
    try {
      const lookup = this.deps.lookup ?? defaultLookup;
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      });
      let addresses: string[];
      try {
        addresses = await Promise.race([lookup(url.hostname), aborted]);
      } catch {
        return { ok: false, reason: controller.signal.aborted ? "timeout" : "dns", host };
      }
      if (addresses.length === 0) return { ok: false, reason: "dns", host };
      const policy = this.deps.addressPolicy ?? DEFAULT_ADDRESS_POLICY;
      // Every address must pass: a host that resolves to one public and one private address is refused outright.
      if (!addresses.every((a) => net.isIP(a) !== 0 && policy.allows(a))) {
        return { ok: false, reason: "address_blocked", host };
      }
      const address = addresses[0] as string;
      const fetched = await get(url, address, controller.signal, this.deps);
      if (!fetched.ok) return { ok: false, reason: fetched.reason, host };
      let doc: unknown;
      try {
        doc = JSON.parse(fetched.body);
      } catch {
        return { ok: false, reason: "json", host };
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, reason: "json", host };
      if ((doc as Record<string, unknown>).client_id !== clientId) {
        return { ok: false, reason: "client_id_mismatch", host };
      }
      const checked = checkClientMetadata(doc);
      if (!checked.ok) return { ok: false, reason: "metadata", host };
      return { ok: true, metadata: checked.metadata, host };
    } finally {
      clearTimeout(timer);
      this.inFlight--;
    }
  }
}
