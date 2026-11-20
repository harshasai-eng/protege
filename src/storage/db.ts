import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config/settings.ts";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;

export interface Storage {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/** Database problem worded for the user */
export class StorageError extends Error {
  override name = "StorageError";
}

// Migration files shipped with Protege: <project>/drizzle
const MIGRATIONS = join(import.meta.dirname, "..", "..", "drizzle");

/** Opens (or creates) the database, then applies any migrations it's missing */
export async function openDatabase(
  file: string,
  storageConfig: Config["storage"],
  migrationsFolder: string = MIGRATIONS,
): Promise<Storage> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const sqlite = new Database(file);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma(`busy_timeout = ${storageConfig.busyTimeoutMs}`);
    migrate(sqlite, file, storageConfig, migrationsFolder);
  } catch (err) {
    sqlite.close();
    throw err;
  }
  const db = drizzle({ client: sqlite, schema, casing: "snake_case" });
  return { db, sqlite, close: () => sqlite.close() };
}

// Same table Drizzle's own migrator uses, so drizzle-kit sees the same history
const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC
  )`;

function migrate(
  sqlite: Database.Database,
  file: string,
  storageConfig: Config["storage"],
  migrationsFolder: string,
): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  const newestKnown = Math.max(0, ...migrations.map((m) => m.folderMillis));

  sqlite.exec(CREATE_MIGRATIONS_TABLE);
  const lastApplied = () =>
    Number(
      (sqlite.prepare("SELECT max(created_at) AS last FROM __drizzle_migrations").get() as { last: number | null })
        .last ?? 0,
    );

  const before = lastApplied();
  if (before > newestKnown) {
    throw new StorageError(
      `${file} was updated by a newer version of Protege. Update Protege to use it.`,
    );
  }
  if (!migrations.some((m) => m.folderMillis > before)) return; // nothing to do

  // Back up first, unless the database is brand new. VACUUM INTO can't run inside a transaction
  if (before > 0) {
    const backups = join(dirname(file), "backups");
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const target = join(backups, `protege-${Date.now()}-${process.pid}.db`);
    sqlite.prepare("VACUUM INTO ?").run(target);
  }

  // The migration lock: BEGIN IMMEDIATE takes SQLite's write lock. Another process
  // migrating at the same time waits up to migrationLockTimeoutMs for it
  sqlite.pragma(`busy_timeout = ${storageConfig.migrationLockTimeoutMs}`);
  sqlite.pragma("foreign_keys = OFF"); // table rebuilds need this; checked before commit
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const last = lastApplied(); // read again: another process may have migrated meanwhile
      for (const m of migrations.filter((m) => m.folderMillis > last)) {
        for (const statement of m.sql) if (statement.trim()) sqlite.exec(statement);
        sqlite
          .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
          .run(m.hash, m.folderMillis);
      }
      const broken = sqlite.pragma("foreign_key_check") as unknown[];
      if (broken.length > 0) throw new StorageError(`A migration broke ${broken.length} foreign keys.`);
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma(`busy_timeout = ${storageConfig.busyTimeoutMs}`);
  }
}