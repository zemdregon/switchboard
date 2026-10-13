/**
 * `http` inner backend (T11.3; FR-INN-03, FR-INN-16, LLD §13.2, ADR-0016, ADR-0003).
 *
 * One non-streaming chat-completion request per call to an endpoint the operator runs or reaches. What it deliberately
 * does NOT do:
 * - hold or send a credential: the only request headers are fixed (`content-type`, `accept`, `accept-encoding`,
 *   `content-length`, `host`); nothing comes from configuration or the environment (the schema has no such field);
 * - follow a redirect (any 3xx is a failure), read a proxy environment variable (`node:http` reads none; the agent is
 *   not shared), or keep a connection alive (`agent: false`, so every call is a fresh connection and a fresh locality
 *   decision);
 * - log or echo a prompt or a response: every thrown error is a fixed code, never the endpoint's own text.
 *
 * Locality (LLD §13.2): `resolveLocality` resolves the host name, classifies EVERY returned address, and pins the result
 * to the call's `AbortSignal`; `complete` then connects to that pinned address (so a second lookup cannot differ) and
 * checks the established socket's peer address again. A call gated `local` whose socket turns out not to be loopback is
 * destroyed before a byte is written. A parse or resolution failure is `remote` (fail closed). Only `127.0.0.0/8` and
 * `::1` are `local`: a private (RFC 1918 / unique-local) address is `remote`, as FR-INN-16 says "anything else"; the
 * three-way {@link classifyAddress} is exposed so `doctor` can say which.
 *
 * Request mapping (Proposed in the LLD, fixed here; Assumptions): `POST <base_url>/v1/chat/completions` (or
 * `<base_url>/chat/completions` when the base path already ends in `/v1`), body `{ model, messages: [system, user],
 * max_tokens, temperature: 0, stream: false }`. `response_schema` is NOT sent: structured-output parameters differ between
 * servers and an unknown one makes some refuse the request; the pipeline validates the output either way. The answer is
 * `choices[0].message.content` (a string); usage is `usage.prompt_tokens` and `usage.completion_tokens` when they are
 * non-negative integers, else unknown; the model id is the response's `model` string when present, else the configured one.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import type { InnerAgentSettings } from "./config.js";
import type { InnerBackend, InnerProbeResult, InnerRequest, InnerResult, Locality } from "./port.js";

export type AddressClass = "loopback" | "private" | "remote";

/** Fixed failure codes; the message is never the endpoint's text (it may echo the prompt). */
export type HttpBackendErrorCode =
  | "ABORTED"
  | "CONNECT_FAILED"
  | "LOCALITY_CHANGED"
  | "REDIRECT"
  | "HTTP_STATUS"
  | "RESPONSE_TOO_LARGE"
  | "BAD_ENCODING"
  | "NOT_JSON"
  | "BAD_ENVELOPE";

export class HttpBackendError extends Error {
  override readonly name = "HttpBackendError";
  constructor(readonly code: HttpBackendErrorCode) {
    super(code);
  }
}

// ---- address classification --------------------------------------------------------------------------------------------

function parseIPv4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/u.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

/** Expand an IPv6 literal to eight 16-bit groups, or undefined if it does not parse. Zone ids are rejected. */
function parseIPv6(ip: string): number[] | undefined {
  if (!net.isIPv6(ip) || ip.includes("%")) return undefined;
  let text = ip;
  const tail = text.lastIndexOf(":");
  const v4 = parseIPv4(text.slice(tail + 1));
  if (v4 !== undefined) {
    text = `${text.slice(0, tail + 1)}${((v4[0] as number) * 256 + (v4[1] as number)).toString(16)}:${(
      (v4[2] as number) * 256 + (v4[3] as number)
    ).toString(16)}`;
  }
  const [head = "", rest, ...extra] = text.split("::");
  if (extra.length > 0) return undefined;
  const h = head === "" ? [] : head.split(":");
  const r = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - h.length - r.length;
  if ((rest === undefined && missing !== 0) || missing < 0) return undefined;
  const groups = [...h, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...r].map((g) =>
    /^[0-9a-f]{1,4}$/iu.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  return groups.length === 8 && groups.every((n) => Number.isFinite(n)) ? groups : undefined;
}

/**
 * Classify one IP literal. `loopback`: `127.0.0.0/8`, `::1` and the IPv4-mapped form of a loopback address. `private`:
 * RFC 1918, link-local, CGNAT, unique-local and the like (still `remote` for the gates). Anything that does not parse is
 * `remote` (fail closed).
 */
export function classifyAddress(ip: string): AddressClass {
  const v4 = parseIPv4(ip);
  if (v4 !== undefined) return classifyV4(v4);
  const g = parseIPv6(ip);
  if (g === undefined) return "remote";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (mapped) {
    const hi = g[6] as number;
    const lo = g[7] as number;
    return classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const first = g[0] as number;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return "private";
  return "remote";
}

function classifyV4(b: number[]): AddressClass {
  const [a = 0, c = 0] = b;
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168)) return "private";
  if (a === 169 && c === 254) return "private";
  if (a === 100 && c >= 64 && c <= 127) return "private";
  return "remote";
}

/** `local` only if the set is non-empty and every address is loopback (LLD §13.2). */
export function localityOfAddresses(addresses: readonly string[]): Locality {
  return addresses.length > 0 && addresses.every((a) => classifyAddress(a) === "loopback") ? "local" : "remote";
}

// ---- the backend ---------------------------------------------------------------------------------------------------------

export interface HttpBackendOptions {
  /** Name resolution, injectable for tests. Default `dns.lookup(host, { all: true })`. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Bytes allowed on top of `max_output_tokens * 16` for the response envelope (Assumption: 16 KiB). */
  envelopeOverheadBytes?: number;
}

interface Pinned {
  readonly address: string;
  readonly family: 4 | 6;
  readonly locality: Locality;
}

type HttpBackendSettings = NonNullable<InnerAgentSettings["backend"]>;

const BYTES_PER_TOKEN = 16; // Assumption: generous for multi-byte and JSON-escaped text.
const DEFAULT_ENVELOPE_OVERHEAD = 16_384;
const CANARY_REQUEST: InnerRequest = {
  task: "run_title",
  template_version: "canary.v1",
  system: 'Reply with exactly this JSON and nothing else: {"ok":true}',
  user: "ping",
  max_output_tokens: 20,
  response_schema: { type: "object" },
};

const abortReason = (): HttpBackendError => new HttpBackendError("ABORTED");

export function createHttpBackend(backend: HttpBackendSettings, options: HttpBackendOptions = {}): InnerBackend {
  if (backend.kind !== "http" || backend.baseUrl === undefined) {
    throw new Error("createHttpBackend needs an http backend with a base_url");
  }
  const base = new URL(backend.baseUrl);
  const isTls = base.protocol === "https:";
  const hostname = base.hostname.startsWith("[") ? base.hostname.slice(1, -1) : base.hostname;
  const port = base.port !== "" ? Number(base.port) : isTls ? 443 : 80;
  const basePath = base.pathname.replace(/\/+$/u, "");
  const endpointPath = `${basePath}${basePath.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
  const overhead = options.envelopeOverheadBytes ?? DEFAULT_ENVELOPE_OVERHEAD;
  const resolve =
    options.resolve ??
    (async (name: string) => (await dnsLookup(name, { all: true, verbatim: true })).map((a) => a.address));
  const pins = new WeakMap<AbortSignal, Pinned>();

  async function resolvePinned(): Promise<Pinned> {
    let addresses: readonly string[];
    try {
      addresses = net.isIP(hostname) !== 0 ? [hostname] : await resolve(hostname);
    } catch {
      return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4, locality: "remote" }; // unresolved: remote
    }
    const first = addresses[0];
    if (first === undefined) return { address: hostname, family: 4, locality: "remote" };
    return { address: first, family: net.isIPv6(first) ? 6 : 4, locality: localityOfAddresses(addresses) };
  }

  /** One request. Connects only to `pin.address` and re-checks the peer when the call was gated `local`. */
  function post(body: string, pin: Pinned, maxBytes: number, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolveBody, reject) => {
      if (signal.aborted) return reject(abortReason());
      let settled = false;
      let req: ClientRequest | undefined;
      const done = (err: HttpBackendError | undefined, value?: string) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (err !== undefined) {
          req?.destroy();
          reject(err);
        } else resolveBody(value as string);
      };
      const onAbort = () => done(abortReason());
      signal.addEventListener("abort", onAbort, { once: true });

      const common = {
        host: hostname,
        port,
        path: endpointPath,
        method: "POST",
        agent: false as const,
        // The address was chosen and classified by resolveLocality: no second lookup can differ.
        lookup: ((_name: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          // `all: true` is how Node's address selection asks; answer with exactly the one pinned address.
          if (opts?.all === true) cb(null, [{ address: pin.address, family: pin.family }]);
          else cb(null, pin.address, pin.family);
        }) as never,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "identity",
          "content-length": Buffer.byteLength(body, "utf8"),
        },
      };
      try {
        req = (isTls ? https : http).request(
          isTls && net.isIP(hostname) === 0 ? { ...common, servername: hostname } : common,
          (res: IncomingMessage) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) return done(new HttpBackendError("REDIRECT"));
            if (status < 200 || status >= 300) return done(new HttpBackendError("HTTP_STATUS"));
            const enc = res.headers["content-encoding"];
            if (enc !== undefined && enc !== "identity") return done(new HttpBackendError("BAD_ENCODING"));
            const declared = Number(res.headers["content-length"]);
            if (Number.isFinite(declared) && declared > maxBytes)
              return done(new HttpBackendError("RESPONSE_TOO_LARGE"));
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (c: Buffer) => {
              total += c.length;
              if (total > maxBytes) return done(new HttpBackendError("RESPONSE_TOO_LARGE"));
              chunks.push(c);
            });
            res.on("end", () => done(undefined, Buffer.concat(chunks).toString("utf8")));
            res.on("error", () => done(new HttpBackendError("CONNECT_FAILED")));
            res.on("aborted", () => done(new HttpBackendError("CONNECT_FAILED")));
          },
        );
      } catch {
        return done(new HttpBackendError("CONNECT_FAILED"));
      }
      req.on("error", () => done(new HttpBackendError("CONNECT_FAILED")));
      req.on("socket", (socket) => {
        const check = () => {
          // Gated `local` means the peer must be loopback; the body is written only after this passes.
          if (pin.locality === "local" && classifyAddress(socket.remoteAddress ?? "") !== "loopback") {
            done(new HttpBackendError("LOCALITY_CHANGED"));
          } else if (!settled) req?.end(body);
        };
        if (socket.connecting) socket.once("connect", check);
        else check();
      });
    });
  }

  function decodeEnvelope(raw: string, fallbackModel: string): InnerResult {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HttpBackendError("NOT_JSON");
    }
    const obj = json as {
      choices?: { message?: { content?: unknown } }[];
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } | null;
    const content = obj !== null && typeof obj === "object" ? obj.choices?.[0]?.message?.content : undefined;
    if (typeof content !== "string") throw new HttpBackendError("BAD_ENVELOPE");
    const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
    const usage =
      obj?.usage !== undefined && obj.usage !== null && typeof obj.usage === "object"
        ? { in: count(obj.usage.prompt_tokens), out: count(obj.usage.completion_tokens) }
        : undefined;
    return {
      text: content,
      ...(usage !== undefined ? { usage } : {}),
      model_id: typeof obj?.model === "string" && obj.model !== "" ? obj.model.slice(0, 256) : fallbackModel,
    };
  }

  async function exchange(req: InnerRequest, pin: Pinned, signal: AbortSignal): Promise<InnerResult> {
    const body = JSON.stringify({
      model: backend.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.max_output_tokens,
      temperature: 0,
      stream: false,
    });
    const raw = await post(body, pin, req.max_output_tokens * BYTES_PER_TOKEN + overhead, signal);
    return decodeEnvelope(raw, backend.model);
  }

  const self: InnerBackend = {
    kind: "http",
    async resolveLocality(signal) {
      if (signal.aborted) throw abortReason();
      const pin = await resolvePinned();
      pins.set(signal, pin);
      return pin.locality;
    },
    async complete(req, signal) {
      // The pipeline calls resolveLocality first with this same signal; without that (a direct call) resolve now.
      const pin = pins.get(signal) ?? (await resolvePinned());
      return exchange(req, pin, signal);
    },
    async probe(signal): Promise<InnerProbeResult> {
      // Defence in depth: the caller applies the gates; the probe itself never contacts a remote endpoint unless allowed.
      const pin = await resolvePinned();
      if (pin.locality === "remote" && !backend.allowRemote) {
        return { reachable: false, canary_ok: false, eligible: true, detail: "REMOTE_NOT_ALLOWED" };
      }
      try {
        const res = await exchange(CANARY_REQUEST, pin, signal);
        let ok = false;
        try {
          ok = (JSON.parse(res.text) as { ok?: unknown } | null)?.ok === true;
        } catch {
          ok = false;
        }
        return { reachable: true, canary_ok: ok, eligible: true, detail: ok ? "OK" : "CANARY_MISMATCH" };
      } catch (e) {
        const code = e instanceof HttpBackendError ? e.code : "CONNECT_FAILED";
        return {
          reachable: code !== "CONNECT_FAILED" && code !== "ABORTED",
          canary_ok: false,
          eligible: true,
          detail: code,
        };
      }
    },
  };
  return self;
}
