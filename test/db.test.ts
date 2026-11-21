import Database from "better-sqlite3";
import { type ChildProcess, fork } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config/settings.ts";
import { openDatabase, retryBusy, type Storage, StorageBusyError, StorageError, write } from "../src/storage/db.ts";
import { workflows } from "../src/storage/schema.ts";

const settings = configSchema.parse({ model: { name: "test-model" } }).storage;

let dir: string;
let file: string;
let opened: Storage[];
let child: ChildProcess | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  file = join(dir, "protege.db");
  opened = [];
});
afterEach(async () => {
  for (const s of opened) s.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  await rm(dir, { recursive: true, force: true });
});

const open = async (options?: Parameters<typeof openDatabase>[2]) => {
  const s = await openDatabase(file, settings, options);
  opened.push(s);
  return s;
};

const tables = (s: Storage) =>
  (s.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);

const addWorkflow = (s: Storage, id: string) =>
  write(s.db, (tx) => tx.insert(workflows).values({ id, name: id, description: "", createdAt: 1, updatedAt: 1 }).run());

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

  it("uses WAL, foreign keys and the short busy timeout", async () => {
    const s = await open();
    expect(s.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(s.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(s.sqlite.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    expect(s.sqlite.pragma("busy_timeout", { simple: true })).toBe(100);
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
    const migrationsFolder = join(dir, "drizzle");
    await cp(join(import.meta.dirname, "..", "drizzle"), migrationsFolder, { recursive: true });
    (await open({ migrationsFolder })).close();
    opened = [];

    const journalFile = join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    journal.entries.push({ idx: 1, version: "6", when: Date.now(), tag: "0001_test", breakpoints: true });
    await writeFile(journalFile, JSON.stringify(journal));
    await writeFile(join(migrationsFolder, "0001_test.sql"), "ALTER TABLE workflows ADD COLUMN note text;");

    const s = await open({ migrationsFolder });
    const columns = (s.sqlite.pragma("table_info(workflows)") as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("note");
    expect(await readdir(join(dir, "backups"))).toEqual([expect.stringMatching(/^protege-\d+\.db$/)]);
  });

  it("waits for update.lock while another process holds it", async () => {
    child = fork(join(import.meta.dirname, "fixtures", "hold-lock.ts"), [join(dir, "update.lock")]);
    expect(await new Promise((resolve) => child!.once("message", resolve))).toBe("held");
    let waiting = false;
    const opening = open({ onWaiting: () => (waiting = true) });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(waiting).toBe(true);
    child.kill("SIGKILL");
    const s = await opening;
    expect(tables(s)).toContain("workflows");
  });
});

describe("writes", () => {
  it("retries while another connection holds the write lock", async () => {
    const s = await open();
    const other = new Database(file);
    other.exec("BEGIN IMMEDIATE");
    setTimeout(() => other.exec("COMMIT"), 300);
    await retryBusy(() => addWorkflow(s, "w1"), 5_000);
    other.close();
    expect(s.sqlite.prepare("SELECT count(*) AS n FROM workflows").get()).toEqual({ n: 1 });
  });

  it("gives up with StorageBusyError when the budget runs out", async () => {
    const s = await open();
    const other = new Database(file);
    other.exec("BEGIN IMMEDIATE");
    await expect(retryBusy(() => addWorkflow(s, "w1"), 300)).rejects.toBeInstanceOf(StorageBusyError);
    other.exec("ROLLBACK");
    other.close();
  });

  it("passes other errors straight through", async () => {
    const s = await open();
    addWorkflow(s, "w1");
    await expect(retryBusy(() => addWorkflow(s, "w1"), 5_000)).rejects.toThrow(/UNIQUE/);
  });

  it("only takes synchronous functions", async () => {
    const s = await open();
    // @ts-expect-error: a transaction can't span an await
    expect(() => write(s.db, async () => 1)).toThrow(/promise/);
  });

  it("starts transactions only in db.ts", async () => {
    const files = (await readdir(join(import.meta.dirname, "..", "src"), { recursive: true }))
      .filter((f) => f.endsWith(".ts") && f !== join("storage", "db.ts"));
    for (const f of files) {
      const text = await readFile(join(import.meta.dirname, "..", "src", f), "utf8");
      expect(text, f).not.toMatch(/\.transaction\(|\bBEGIN\b/);
    }
  });
});