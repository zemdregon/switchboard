import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactError, ArtifactStore, REDACTION_MARKER } from "./index.js";

let dir: string;
let store: ArtifactStore;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-art-")));
  store = new ArtifactStore(path.join(dir, "artifacts"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function walk(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
  );
}

// Obviously fake fixtures, assembled at runtime so the source itself has no scannable token shape.
const FAKE = {
  aws: `AKIA${"EXAMPLE".repeat(2)}12`.slice(0, 20),
  github: `ghp_${"FAKEFAKE".repeat(5)}`,
  sk: `sk-${"fakefakefake".repeat(3)}`,
  bearer: "FAKEBEARERTOKEN1234567890",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----",
};

describe("artifact store", () => {
  it("addresses content by SHA-256 and dedups identical content", async () => {
    const a = await store.put("hello artifacts");
    const b = await store.put(Buffer.from("hello artifacts"));
    expect(a.sha256).toBe(createHash("sha256").update("hello artifacts").digest("hex"));
    expect(b.sha256).toBe(a.sha256);
    expect(walk(store.root)).toHaveLength(1);
    expect((await store.get(a.sha256)).toString()).toBe("hello artifacts");
  });

  it("uses 0600 files and 0700 directories under ab/cd/<hash>", async () => {
    const { sha256 } = await store.put("modes");
    const file = path.join(store.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    expect(store.pathFor(sha256)).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const d of [store.root, path.dirname(path.dirname(file)), path.dirname(file)]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
  });

  it("redacts secrets before hashing and writing; the raw secret is never on disk", async () => {
    const input = [
      `aws=${FAKE.aws}`,
      `token ${FAKE.github}`,
      `key ${FAKE.sk}`,
      `Authorization: Bearer ${FAKE.bearer}`,
      FAKE.pem,
    ].join("\n");
    const res = await store.put(input);
    expect(res.redacted).toBe(true);
    const text = (await store.get(res.sha256)).toString();
    expect(text).toContain(REDACTION_MARKER);
    expect(text).toContain("Authorization: Bearer [REDACTED]");
    // Address is of the redacted bytes, not the raw input.
    expect(res.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(res.sha256).not.toBe(createHash("sha256").update(input).digest("hex"));
    for (const f of walk(dir)) {
      const disk = readFileSync(f, "latin1");
      for (const secret of [FAKE.aws, FAKE.github, FAKE.sk, FAKE.bearer, "FAKEFAKEFAKEFAKE"]) {
        expect(disk).not.toContain(secret);
      }
    }
    expect(walk(dir).every((f) => !path.basename(f).startsWith(".tmp-"))).toBe(true);
  });

  it("supports a pluggable redactor applied before hashing", async () => {
    const s = new ArtifactStore(path.join(dir, "custom"), { redact: (b) => Buffer.from(b.toString().toUpperCase()) });
    const r = await s.put("abc");
    expect(r.sha256).toBe(createHash("sha256").update("ABC").digest("hex"));
  });

  it("leaves binary content intact when nothing matches", async () => {
    const bin = Buffer.from([0, 255, 254, 128, 1, 2, 3]);
    const r = await store.put(bin);
    expect(r.redacted).toBe(false);
    expect((await store.get(r.sha256)).equals(bin)).toBe(true);
  });

  it("detects a corrupted file on read", async () => {
    const { sha256 } = await store.put("original");
    writeFileSync(store.pathFor(sha256), "tampered");
    await expect(store.get(sha256)).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
    // A subsequent put of the same content repairs it.
    await store.put("original");
    expect((await store.get(sha256)).toString()).toBe("original");
  });

  it("reports missing artifacts", async () => {
    await expect(store.get("a".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await store.has("a".repeat(64))).toBe(false);
  });

  it("handles concurrent identical writes safely", async () => {
    const payload = "x".repeat(200_000);
    const results = await Promise.all(Array.from({ length: 25 }, () => store.put(payload)));
    expect(new Set(results.map((r) => r.sha256)).size).toBe(1);
    const files = walk(store.root);
    expect(files).toHaveLength(1);
    expect((await store.get(results[0]?.sha256 ?? "")).toString()).toBe(payload);
  });

  it("rejects path traversal and malformed hashes", async () => {
    const bad = [
      "../../etc/passwd",
      "..",
      "",
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      `${"a".repeat(60)}/../`,
      "a/b",
    ];
    for (const h of bad) {
      expect(() => store.pathFor(h)).toThrow(ArtifactError);
      await expect(store.get(h)).rejects.toMatchObject({ code: "INVALID_HASH" });
      await expect(store.has(h)).rejects.toMatchObject({ code: "INVALID_HASH" });
    }
  });

  it("succeeds and creates traversable directories under a hostile umask", async () => {
    const origUmask = process.umask(0o177);
    try {
      const hostileStore = new ArtifactStore(path.join(dir, "hostile-artifacts"));
      const res = await hostileStore.put("hostile umask payload");
      expect(await hostileStore.has(res.sha256)).toBe(true);
      expect((await hostileStore.get(res.sha256)).toString()).toBe("hostile umask payload");

      const file = hostileStore.pathFor(res.sha256);
      expect(statSync(file).mode & 0o777).toBe(0o600);

      const shard1 = path.dirname(path.dirname(file));
      const shard2 = path.dirname(file);
      for (const d of [hostileStore.root, shard1, shard2]) {
        const mode = statSync(d).mode & 0o777;
        expect(mode).toBe(0o700);
        expect(mode & 0o100).toBe(0o100);
        expect(readdirSync(d)).toBeDefined();
      }
    } finally {
      process.umask(origUmask);
    }
  });
});
