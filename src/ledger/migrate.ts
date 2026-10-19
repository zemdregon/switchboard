import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { MigrationError } from "./errors.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

/** SHA-256 of `sql`, followed by `postSql` when present (so every earlier migration's checksum is unchanged). */
export function migrationChecksum(m: Migration): string {
  const text = m.postSql === undefined ? m.sql : `${m.sql}\n-- postSql\n${m.postSql}`;
  return createHash("sha256").update(text).digest("hex");
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function readApplied(db: Database.Database): AppliedRow[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return [];
  return db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as AppliedRow[];
}

export function currentSchemaVersion(db: Database.Database): number {
  return readApplied(db).reduce((max, r) => Math.max(max, r.version), 0);
}

/**
 * Apply pending migrations in order, each in its own transaction together with its `schema_migrations` row.
 * Forward-only: refuses a database that records a version this build does not know (written by a newer release) and
 * aborts on a checksum mismatch of an already-applied migration (LLD §1). Returns the versions applied by this call.
 * `migrations` is injectable for tests.
 */
export function migrate(
  db: Database.Database,
  now: () => Date = () => new Date(),
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  const known = new Map(migrations.map((m) => [m.version, m]));
  const applied = readApplied(db);
  for (const row of applied) {
    const m = known.get(row.version);
    if (!m) {
      const newest = migrations.reduce((max, x) => Math.max(max, x.version), 0);
      throw new MigrationError(
        `database schema version ${row.version} is newer than this build supports (${newest}); refusing to open (forward-only migrations)`,
      );
    }
    if (row.checksum !== migrationChecksum(m)) {
      throw new MigrationError(`checksum mismatch for applied migration ${row.version} (${row.name}); aborting`);
    }
  }
  const appliedVersions = new Set(applied.map((r) => r.version));
  const done: number[] = [];
  const insert = (m: Migration) =>
    db
      .prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
      .run(m.version, m.name, migrationChecksum(m), now().toISOString());
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (appliedVersions.has(m.version)) continue;
    // A rebuild of a referenced table runs with foreign keys off (the pragma is a no-op inside a transaction), then the
    // whole database is checked before commit and the setting is restored (SQLite "ALTER TABLE" procedure, LLD §1).
    const fkOff = m.foreignKeysOff === true && db.pragma("foreign_keys", { simple: true }) === 1;
    if (fkOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(m.sql);
        m.backfill?.(db);
        if (m.postSql !== undefined) db.exec(m.postSql);
        insert(m);
        if (fkOff && (db.pragma("foreign_key_check") as unknown[]).length > 0) {
          throw new MigrationError(`migration ${m.version} (${m.name}) left foreign key violations; aborting`);
        }
      })();
    } finally {
      if (fkOff) db.pragma("foreign_keys = ON");
    }
    done.push(m.version);
  }
  return done;
}
