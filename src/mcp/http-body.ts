/** Bounded request-body reader for the HTTP transport's OAuth endpoints (T13.7, T13.8; LLD §3.3). */
import type { IncomingMessage } from "node:http";

export type BodyResult = { ok: true; body: Buffer } | { ok: false; status: 400 | 413 };

/** Read the whole body, refusing (413) one that declares or reaches more than `limit` bytes without buffering it. */
export function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ ok: false, status: 413 });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: BodyResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413 });
        req.resume();
        return;
      }
      if (!done) chunks.push(chunk);
    });
    req.on("error", () => finish({ ok: false, status: 400 }));
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
  });
}

/** The media type of the request without parameters, lower case. */
export function mediaType(req: IncomingMessage): string | undefined {
  return (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
}
