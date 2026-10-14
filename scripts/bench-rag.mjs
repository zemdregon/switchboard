// Retrieval-store spike (T12.0; FR-RAG-04, 05, 11; Q-48; TDD §3.13.1). Not part of `npm test`.
// Measures in-process brute-force cosine search over float32 vectors stored as SQLite BLOBs, at several chunk counts
// and vector sizes, with the existing better-sqlite3 dependency only. Vectors and chunk text are synthetic (seeded
// PRNG); no embedding model is called and no repository content is read. Each store is a temporary file under
// $TMPDIR (or the OS temp directory) and is deleted afterwards.
//
// Two search paths are timed per (chunks, dimension):
//   sqlite: every query streams all vector BLOBs from the store and scores them (no cache in the process);
//   memory: vectors are loaded once into one Float32Array, then every query scores that array.
// Vectors are L2-normalised at insert, so cosine similarity is a dot product. Top-k is kept by insertion into a small
// sorted array. Timings are wall-clock (performance.now) medians and p95 over --queries queries after one warm-up.
//
// Usage: node scripts/bench-rag.mjs [--chunks 1000,10000,50000] [--dims 384,768,1536] [--queries 20] [--top-k 8]
//                                    [--text-bytes 1200] [--json]
//        node scripts/bench-rag.mjs --chunk-sizes <git checkout> [--window-lines 40] [--json]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const listOf = (name, dflt) =>
  String(argOf(name, dflt))
    .split(",")
    .map((s) => Number(s.trim()));
const CHUNKS = listOf("--chunks", "1000,10000,25000,50000,100000");
const DIMS = listOf("--dims", "384,768,1536");
const QUERIES = Number(argOf("--queries", 20));
const TOP_K = Number(argOf("--top-k", 8));
const TEXT_BYTES = Number(argOf("--text-bytes", 1200));
const AS_JSON = process.argv.includes("--json");

// Mulberry32: small deterministic PRNG so every run builds the same vectors.
const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomUnitVector = (rand, dim) => {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const x = rand() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] *= inv;
  return v;
};

// Little-endian float32 BLOB (the LLD §14.2 format). Node runs little-endian on every supported platform; asserted.
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("big-endian host: not supported");
const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (buf, dim) =>
  buf.byteOffset % 4 === 0
    ? new Float32Array(buf.buffer, buf.byteOffset, dim)
    : new Float32Array(new Uint8Array(buf).buffer, 0, dim);

const pushTopK = (top, k, id, score) => {
  if (top.length === k && score <= top[k - 1].score) return;
  let i = top.length < k ? top.length : k - 1;
  if (top.length < k) top.push(null);
  while (i > 0 && top[i - 1].score < score) {
    top[i] = top[i - 1];
    i--;
  }
  top[i] = { id, score };
};

const dot = (a, aOff, b, dim) => {
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[aOff + i] * b[i];
  return s;
};

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
};

const round = (x) => Math.round(x * 10) / 10;

const SCHEMA = `
CREATE TABLE rag_chunk (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  text        BLOB NOT NULL,
  text_sha256 TEXT NOT NULL,
  vector      BLOB NOT NULL
) STRICT;`;

const benchOne = (dir, chunks, dim) => {
  const file = path.join(dir, `bench-${chunks}-${dim}.db`);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(SCHEMA);
  const rand = prng(chunks * 7919 + dim);
  const text = Buffer.alloc(TEXT_BYTES, "x");
  const insert = db.prepare(
    "INSERT INTO rag_chunk (id, path, ordinal, start_line, end_line, text, text_sha256, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const BATCH = 500;
  const insertBatch = db.transaction((from, to) => {
    for (let n = from; n < to; n++) {
      const v = randomUnitVector(rand, dim);
      insert.run(
        `chk_${n.toString(16).padStart(12, "0")}`,
        `src/file${Math.floor(n / 10)}.ts`,
        n % 10,
        (n % 10) * 40 + 1,
        (n % 10) * 40 + 40,
        text,
        "0".repeat(64),
        toBlob(v),
      );
    }
  });
  const t0 = performance.now();
  for (let from = 0; from < chunks; from += BATCH) insertBatch(from, Math.min(chunks, from + BATCH));
  const insertMs = performance.now() - t0;
  db.pragma("wal_checkpoint(TRUNCATE)");
  const fileBytes = statSync(file).size;
  db.close();

  // Reopen so the page cache of this connection starts empty (the OS file cache is not dropped).
  const rdb = new Database(file, { readonly: true });
  const scanStmt = rdb.prepare("SELECT id, vector FROM rag_chunk").raw(true);
  const qrand = prng(424242 + dim);
  const queries = Array.from({ length: QUERIES + 1 }, () => randomUnitVector(qrand, dim));

  const sqliteMs = [];
  for (let q = 0; q < queries.length; q++) {
    const t = performance.now();
    const top = [];
    for (const [id, blob] of scanStmt.iterate()) pushTopK(top, TOP_K, id, dot(fromBlob(blob, dim), 0, queries[q], dim));
    if (q > 0) sqliteMs.push(performance.now() - t);
  }

  const tl = performance.now();
  const ids = new Array(chunks);
  const matrix = new Float32Array(chunks * dim);
  let row = 0;
  for (const [id, blob] of scanStmt.iterate()) {
    ids[row] = id;
    matrix.set(fromBlob(blob, dim), row * dim);
    row++;
  }
  const loadMs = performance.now() - tl;
  rdb.close();

  const memoryMs = [];
  for (let q = 0; q < queries.length; q++) {
    const t = performance.now();
    const top = [];
    for (let r = 0; r < chunks; r++) pushTopK(top, TOP_K, ids[r], dot(matrix, r * dim, queries[q], dim));
    if (q > 0) memoryMs.push(performance.now() - t);
  }

  rmSync(file, { force: true });
  return {
    chunks,
    dim,
    file_mib: round(fileBytes / 1048576),
    insert_ms: round(insertMs),
    load_ms: round(loadMs),
    sqlite: Object.fromEntries(Object.entries(stats(sqliteMs)).map(([k, v]) => [k, round(v)])),
    memory: Object.fromEntries(Object.entries(stats(memoryMs)).map(([k, v]) => [k, round(v)])),
  };
};

// --chunk-sizes <git dir>: instead of the search benchmark, split every tracked text file of a Git checkout into windows
// of --window-lines lines (no overlap) and report the size distribution, with the controller's token approximation
// ceil(bytes / 4) (an Assumption, not a provider count). Reads files locally only; nothing is embedded or sent.
const CHUNK_DIR = argOf("--chunk-sizes", undefined);
if (CHUNK_DIR !== undefined) {
  const WINDOW = Number(argOf("--window-lines", 40));
  const files = execFileSync("git", ["-C", CHUNK_DIR, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const bytes = [];
  for (const f of files) {
    const buf = readFileSync(path.join(CHUNK_DIR, f));
    if (buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += WINDOW) {
      const text = lines.slice(i, i + WINDOW).join("\n");
      if (text.trim() !== "") bytes.push(Buffer.byteLength(text));
    }
  }
  const s = stats(bytes);
  const tok = (b) => Math.ceil(b / 4);
  const out = {
    window_lines: WINDOW,
    files: files.length,
    chunks: bytes.length,
    bytes: s,
    est_tokens: { p50: tok(s.p50), p95: tok(s.p95), max: tok(s.max) },
  };
  console.log(JSON.stringify(out, null, AS_JSON ? 2 : 0));
  process.exit(0);
}

const tmpRoot = process.env.TMPDIR || os.tmpdir();
const dir = mkdtempSync(path.join(tmpRoot, "sb-bench-rag-"));
const sqliteVersion = (() => {
  const d = new Database(":memory:");
  const v = d.prepare("SELECT sqlite_version() AS v").get().v;
  d.close();
  return v;
})();
const env = {
  date: new Date().toISOString(),
  node: process.version,
  sqlite: sqliteVersion,
  platform: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: `${os.cpus()[0]?.model ?? "unknown"} x${os.cpus().length}`,
  mem_gib: round(os.totalmem() / 1073741824),
  queries: QUERIES,
  top_k: TOP_K,
  text_bytes: TEXT_BYTES,
};
const results = [];
try {
  if (!AS_JSON) console.log(JSON.stringify(env));
  for (const dim of DIMS) {
    for (const chunks of CHUNKS) {
      const r = benchOne(dir, chunks, dim);
      results.push(r);
      if (!AS_JSON) {
        console.log(
          `chunks=${r.chunks} dim=${r.dim} file=${r.file_mib}MiB insert=${r.insert_ms}ms load=${r.load_ms}ms ` +
            `sqlite p50/p95/max=${r.sqlite.p50}/${r.sqlite.p95}/${r.sqlite.max}ms ` +
            `memory p50/p95/max=${r.memory.p50}/${r.memory.p95}/${r.memory.max}ms`,
        );
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (AS_JSON) console.log(JSON.stringify({ env, results }, null, 2));
