import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { mkdirSync, renameSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../config/settings.ts";
import { releaseLock, waitForLock } from "./locks.ts";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;
/** The handle a write() function gets */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Storage {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/** A database problem, worded for the user */
export class StorageError extends Error {
  override name = "StorageError";
}

/** A write that couldn't get the database within its budget */
export class StorageBusyError extends StorageError {
  override name = "StorageBusyError";
  constructor() {
    super("The database is busy. If another Protege window is paused or stuck, close it, then try again.");
  }
}

// The migration files, shipped with Protege: <project>/drizzle
const MIGRATIONS = join(import.meta.dirname, "..", "drizzle");

/**
 * Opens (or creates) the database. Pending migrations run under update.lock,
 * next to the database file; while another process holds it, this waits
 */
export async function openDatabase(
  file: string,
  storageConfig: Config["storage"],
  options: { migrationsFolder?: string; signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<Storage> {
  const { migrationsFolder = MIGRATIONS, signal, onWaiting } = options;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const sqlite = new Database(file, { timeout: storageConfig.busyTimeoutMs });
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("synchronous = NORMAL");
    const migrations = readMigrationFiles({ migrationsFolder });
    if (state(sqlite, file, migrations) === "pending") {
      const lock = join(dirname(file), "update.lock");
      await waitForLock(lock, { signal, onNotice: onWaiting });
      try {
        sqlite.pragma("journal_mode = WAL"); // first run: converting needs a moment alone
        if (state(sqlite, file, migrations) === "pending") {
          backUp(sqlite, file);
          await retryBusy(() => migrate(sqlite, migrations), storageConfig.writeBudgetMs);
        }
      } finally {
        releaseLock(lock);
      }
    }
    sqlite.pragma("journal_mode = WAL"); // already set: does nothing
  } catch (err) {
    sqlite.close();
    throw err;
  }
  const db = drizzle({ client: sqlite, schema, casing: "snake_case" });
  return { db, sqlite, close: () => sqlite.close() };
}

/**
 * Runs fn in a BEGIN IMMEDIATE transaction, which takes the write lock before
 * reading anything. Every write goes through here. fn must be synchronous
 */
export function write<T>(db: Db, fn: (tx: Tx) => T extends PromiseLike<unknown> ? never : T): T {
  return db.transaction(fn, { behavior: "immediate" });
}

/**
 * Retries a write while the database is busy: a random 50-500 ms pause between
 * tries, until budgetMs runs out. The process stays responsive while it waits.
 * Safe to retry: with BEGIN IMMEDIATE, "busy" happens before anything is written
 */
export async function retryBusy<T>(fn: () => T, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err)) throw err;
      const left = deadline - Date.now();
      if (left <= 0) throw new StorageBusyError();
      await sleep(Math.min(left, 50 + Math.random() * 450));
    }
  }
}

function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

// Same table Drizzle's own migrator uses, so drizzle-kit sees the same history
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Whether the database is up to date, needs migrations, or is newer than this code */
function state(sqlite: Database.Database, file: string, migrations: MigrationMeta[]): "current" | "pending" {
  const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATIONS_TABLE);
  const last = exists
    ? Number((sqlite.prepare(`SELECT max(created_at) AS last FROM ${MIGRATIONS_TABLE}`).get() as { last: number | null }).last ?? 0)
    : 0;
  const newestKnown = Math.max(0, ...migrations.map((m) => m.folderMillis));
  if (last > newestKnown) throw new StorageError(`${file} was updated by a newer version of Protege. Update Protege to use it.`);
  return exists && last === newestKnown ? "current" : "pending";
}

// Unless the database is brand new: VACUUM INTO a temporary name, then rename it
function backUp(sqlite: Database.Database, file: string): void {
  const hasTables = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get();
  if (!hasTables) return;
  const backups = join(dirname(file), "backups");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const target = join(backups, `protege-${Date.now()}.db`);
  sqlite.prepare("VACUUM INTO ?").run(`${target}.tmp`);
  renameSync(`${target}.tmp`, target);
}

// One transaction: all of a migration's statements apply, or none do
function migrate(sqlite: Database.Database, migrations: MigrationMeta[]): void {
  sqlite.pragma("foreign_keys = OFF"); // table rebuilds need this; checked before commit
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)`);
      const last = Number((sqlite.prepare(`SELECT max(created_at) AS last FROM ${MIGRATIONS_TABLE}`).get() as { last: number | null }).last ?? 0);
      for (const m of migrations.filter((m) => m.folderMillis > last)) {
        for (const statement of m.sql) if (statement.trim()) sqlite.exec(statement);
        sqlite.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`).run(m.hash, m.folderMillis);
      }
      const broken = sqlite.pragma("foreign_key_check") as unknown[];
      if (broken.length > 0) throw new StorageError(`A migration broke ${broken.length} foreign keys.`);
      sqlite.exec("COMMIT");
    } catch (err) {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK"); // SQLite may have rolled back already
      throw err;
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}