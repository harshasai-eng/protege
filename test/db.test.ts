import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Storage, StorageError } from "../src/storage/db.ts";

const settings = { busyTimeoutMs: 5_000, migrationLockTimeoutMs: 60_000, artifactRetentionDays: 30 };

let dir: string;
let file: string;
let opened: Storage[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  file = join(dir, "protege.db");
  opened = [];
});
afterEach(async () => {
  for (const s of opened) s.close();
  await rm(dir, { recursive: true, force: true });
});

const open = async (migrations?: string) => {
  const s = await openDatabase(file, settings, migrations);
  opened.push(s);
  return s;
};

const tables = (s: Storage) =>
  (s.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);

describe("openDatabase", () => {
  it("creates every table in a new database", async () => {
    const s = await open();
    expect(tables(s)).toEqual([
      "__drizzle_migrations",
      "items",
      "runs",
      "session_skills",
      "sessions",
      "skill_version_files",
      "skill_versions",
      "skills",
      "workflows",
    ]);
  });

  it("uses WAL, foreign keys and the busy timeout", async () => {
    const s = await open();
    expect(s.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(s.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(s.sqlite.pragma("busy_timeout", { simple: true })).toBe(5_000);
  });

  it("does nothing on a second open, and makes no backup", async () => {
    (await open()).close();
    opened = [];
    await open();
    await expect(readdir(join(dir, "backups"))).rejects.toThrow(/ENOENT/);
  });

  it("enforces the schema's rules", async () => {
    const s = await open();
    const now = Date.now();
    s.sqlite.prepare("INSERT INTO workflows VALUES ('w1', 'Expense audit', 'd', ?, ?)").run(now, now);
    const subagentWithoutParent = () =>
      s.sqlite
        .prepare(
          "INSERT INTO sessions (id, workflow_id, kind, cwd, started_at, last_activity_at) VALUES ('s1', 'w1', 'subagent', '/x', ?, ?)",
        )
        .run(now, now);
    expect(subagentWithoutParent).toThrow(/sessions_parent/);
  });

  it("refuses a database from a newer Protege", async () => {
    const s = await open();
    s.sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', ?)").run(Date.now() * 2);
    s.close();
    opened = [];
    await expect(open()).rejects.toThrow(StorageError);
  });

  it("backs up, then applies a new migration", async () => {
    // A copy of the real migrations, plus a made-up second one
    const migrations = join(dir, "drizzle");
    await cp(join(import.meta.dirname, "..", "drizzle"), migrations, { recursive: true });
    (await open(migrations)).close();
    opened = [];

    const journalFile = join(migrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    journal.entries.push({ idx: 1, version: "6", when: Date.now(), tag: "0001_test", breakpoints: true });
    await writeFile(journalFile, JSON.stringify(journal));
    await writeFile(join(migrations, "0001_test.sql"), "ALTER TABLE workflows ADD COLUMN note text;");

    const s = await open(migrations);
    const columns = (s.sqlite.pragma("table_info(workflows)") as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("note");
    expect(await readdir(join(dir, "backups"))).toHaveLength(1);
  });
});