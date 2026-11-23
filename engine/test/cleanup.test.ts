import Database from "better-sqlite3";
import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { protegePaths } from "../../config/paths.ts";
import { configSchema } from "../../config/settings.ts";
import { openDatabase, type Storage } from "../../storage/db.ts";
import { lockState, takeLock } from "../../storage/locks.ts";
import { loadItems, startRun, unfinishedRun } from "../../storage/runs.ts";
import { createSession, getSession, type NewSession, releaseSession, sessionLockFile } from "../../storage/sessions.ts";
import { createWorkflow } from "../../storage/workflows.ts";
import { runCleanup } from "../cleanup.ts";

const config = configSchema.parse({ model: { name: "test-model" } });
const budget = config.storage.writeBudgetMs;
const DAY = 86_400_000;

let paths: ReturnType<typeof protegePaths>;
let storage: Storage;
let workflowId: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
  paths = protegePaths(await mkdtemp(join(tmpdir(), "protege-test-")));
  storage = await openDatabase(paths.database, config.storage);
  workflowId = (await createWorkflow(storage.db, { name: "Expense audit", description: "d" }, budget)).id;
});
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  storage.close();
  await rm(paths.home, { recursive: true, force: true });
});

const cleanup = (now?: number) => runCleanup({ db: storage.db, paths, storage: config.storage, now });

/** A session whose process has gone: its lock is free again */
async function leftBehind(overrides: Partial<NewSession> = {}, withRun = true) {
  const s = await createSession(
    { db: storage.db, locksDir: paths.locks, storage: config.storage },
    { workflowId, kind: "interactive", cwd: join(paths.home, "project"), setup: { instructions: "i", tools: [] }, ...overrides },
  );
  if (withRun) await startRun(storage.db, s.id, [{ itemType: "message:user", itemJson: { content: "hi" } }], budget);
  releaseSession(paths.locks, s.id);
  return s;
}

/** Another process holding a lock, like a second Protege window */
async function heldElsewhere(file: string) {
  child = fork(join(import.meta.dirname, "..", "..", "storage", "test", "fixtures", "hold-lock.ts"), [file]);
  expect(await new Promise((resolve) => child!.once("message", resolve))).toBe("held");
}

/** A file or folder last changed `days` ago */
function aged(path: string, days: number) {
  const when = new Date(Date.now() - days * DAY);
  utimesSync(path, when, when);
}

describe("runCleanup", () => {
  it("does nothing while another Protege holds cleanup.lock", async () => {
    const s = await leftBehind();
    await heldElsewhere(paths.cleanupLock);
    expect(await cleanup()).toMatchObject({ skipped: true, recovered: 0 });
    expect(unfinishedRun(storage.db, s.id)).toBeDefined();
  });

  it("recovers an unfinished run whose process is gone, with the interrupted note", async () => {
    const s = await leftBehind();
    expect(await cleanup()).toMatchObject({ skipped: false, recovered: 1 });
    expect(unfinishedRun(storage.db, s.id)).toBeUndefined();
    expect(loadItems(storage.db, s.id).at(-1)?.itemType).toBe("pg:run_note");
    expect(getSession(storage.db, s.id)?.closedAt).toBeNull(); // interactive: stays open
    expect(lockState(sessionLockFile(paths.locks, s.id))).toBe("free");
  });

  it("leaves sessions alone that another process, or this one, is driving", async () => {
    const elsewhere = await leftBehind();
    const mine = await leftBehind();
    await heldElsewhere(sessionLockFile(paths.locks, elsewhere.id));
    expect(takeLock(sessionLockFile(paths.locks, mine.id))).toBe(true);
    expect(await cleanup()).toMatchObject({ recovered: 0 });
    expect(unfinishedRun(storage.db, elsewhere.id)).toBeDefined();
    expect(unfinishedRun(storage.db, mine.id)).toBeDefined();
    expect(lockState(sessionLockFile(paths.locks, mine.id))).toBe("mine");
    releaseSession(paths.locks, mine.id);
  });

  it("closes a worker's session that was cut short, as interrupted", async () => {
    const run = await leftBehind({ kind: "worker" });
    const neverRan = await leftBehind({ kind: "worker" }, false);
    expect(await cleanup()).toMatchObject({ recovered: 1, closed: 2 });
    expect(getSession(storage.db, run.id)?.closeReason).toBe("interrupted");
    expect(getSession(storage.db, neverRan.id)?.closeReason).toBe("interrupted");
  });

  it("moves artifacts folders past retention to the trash, then empties it", async () => {
    mkdirSync(join(paths.artifacts, "old-session", "call_1"), { recursive: true });
    mkdirSync(join(paths.artifacts, "new-session"), { recursive: true });
    aged(join(paths.artifacts, "old-session"), 31);
    aged(join(paths.artifacts, "new-session"), 29);
    expect(await cleanup()).toMatchObject({ artifacts: 1 });
    expect(readdirSync(paths.artifacts)).toEqual(["new-session"]);
    expect(readdirSync(paths.trash)).toEqual([]);
  });

  it("deletes lock files of closed sessions, and old ones with no session", async () => {
    const worker = await leftBehind({ kind: "worker" }, false);
    mkdirSync(paths.locks, { recursive: true });
    writeFileSync(join(paths.locks, "gone-old.lock"), "");
    writeFileSync(join(paths.locks, "gone-new.lock"), "");
    aged(join(paths.locks, "gone-old.lock"), 2);
    const open = await leftBehind({}, false);
    expect(await cleanup()).toMatchObject({ lockFiles: 2 });
    expect(readdirSync(paths.locks).sort()).toEqual(["gone-new.lock", `${open.id}.lock`].sort());
    expect(existsSync(sessionLockFile(paths.locks, worker.id))).toBe(false); // closed by this same cleanup
  });

  it("deletes leftovers and logs past their age, and keeps newer ones", async () => {
    mkdirSync(join(paths.runtime, ".tmp-old"), { recursive: true });
    mkdirSync(join(paths.runtime, ".tmp-new"), { recursive: true });
    mkdirSync(paths.backups, { recursive: true });
    writeFileSync(join(paths.backups, "protege-1.db.tmp"), "");
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(join(paths.logs, "protege-2026-09-01.log"), "");
    writeFileSync(join(paths.logs, "protege-2026-11-01.log"), "");
    aged(join(paths.runtime, ".tmp-old"), 2);
    aged(join(paths.backups, "protege-1.db.tmp"), 2);
    aged(join(paths.logs, "protege-2026-09-01.log"), 31);
    expect(await cleanup()).toMatchObject({ leftovers: 2, logs: 1 });
    expect(readdirSync(paths.runtime)).toEqual([".tmp-new"]);
    expect(readdirSync(paths.backups)).toEqual([]);
    expect(readdirSync(paths.logs)).toEqual(["protege-2026-11-01.log"]);
  });

  it("stops the database steps when the database stays busy, and still does the file steps", async () => {
    const s = await leftBehind();
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(join(paths.logs, "protege-2026-09-01.log"), "");
    aged(join(paths.logs, "protege-2026-09-01.log"), 31);
    const other = new Database(paths.database);
    other.exec("BEGIN IMMEDIATE"); // a stuck Protege holding the write lock
    try {
      expect(await cleanup()).toMatchObject({ databaseBusy: true, recovered: 0, logs: 1 });
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(unfinishedRun(storage.db, s.id)).toBeDefined(); // the next start carries on
    expect(lockState(sessionLockFile(paths.locks, s.id))).toBe("free");
  });
});