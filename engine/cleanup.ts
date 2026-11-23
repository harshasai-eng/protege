import { type Dirent, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/settings.ts";
import type { protegePaths } from "../config/paths.ts";
import { type Db, StorageBusyError } from "../storage/db.ts";
import { lockState, releaseLock, takeLock } from "../storage/locks.ts";
import { latestRun, recoverRun } from "../storage/runs.ts";
import { closedStates, closeSession, getSession, sessionLockFile, sessionsToRecover } from "../storage/sessions.ts";
import { emptyTrash, moveToTrash } from "../storage/trash.ts";
import { runNote } from "./prompts/notes.ts";

// The startup cleanup: runs in the background once a session is open, so it
// never delays the prompt. Every step can be cut off and run again later

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEFTOVER_AGE = 24 * HOUR; // interrupted work: temporary folders, half-written backups
const LOCK_FILE_AGE = 24 * HOUR; // a lock file with no session row
const LOG_AGE = 30 * DAY;

export interface CleanupContext {
  db: Db;
  paths: ReturnType<typeof protegePaths>;
  storage: Config["storage"];
  signal?: AbortSignal; // shutdown: stop before the next step
  now?: number; // tests move the clock
}

/** What one cleanup did, for the error log and tests */
export interface CleanupReport {
  skipped: boolean; // another Protege is cleaning up
  databaseBusy: boolean; // a write ran out of time: the database steps stopped
  recovered: number;
  closed: number;
  artifacts: number;
  lockFiles: number;
  leftovers: number;
  logs: number;
}

/**
 * One cleanup pass. Takes cleanup.lock (one try: if another Protege holds it,
 * does nothing). Database steps stop at the first write that runs out of time;
 * the file steps run anyway
 */
export async function runCleanup(ctx: CleanupContext): Promise<CleanupReport> {
  const report: CleanupReport = {
    skipped: false,
    databaseBusy: false,
    recovered: 0,
    closed: 0,
    artifacts: 0,
    lockFiles: 0,
    leftovers: 0,
    logs: 0,
  };
  if (!takeLock(ctx.paths.cleanupLock)) return { ...report, skipped: true };
  try {
    try {
      await cleanSessions(ctx, report);
      if (!ctx.signal?.aborted) cleanLockFiles(ctx, report);
    } catch (err) {
      if (!(err instanceof StorageBusyError)) throw err;
      report.databaseBusy = true; // the next start carries on
    }
    if (!ctx.signal?.aborted) cleanFiles(ctx, report);
    return report;
  } finally {
    releaseLock(ctx.paths.cleanupLock);
  }
}

// ---- Database steps

/**
 * One pass per session that needs it: open worker and sub-agent sessions, sessions
 * with an unfinished run, and sessions whose artifacts folder is past retention.
 * Each gets one try at its lock; one held anywhere, this process included, is skipped
 */
async function cleanSessions(ctx: CleanupContext, report: CleanupReport): Promise<void> {
  const now = ctx.now ?? Date.now();
  const budget = ctx.storage.cleanupBudgetMs;
  const oldArtifacts = new Set(
    olderThan(ctx.paths.artifacts, now - ctx.storage.artifactRetentionDays * DAY, (e) => e.isDirectory()),
  );
  const ids = new Set([...sessionsToRecover(ctx.db), ...oldArtifacts]);
  for (const id of ids) {
    if (ctx.signal?.aborted) return;
    const lock = sessionLockFile(ctx.paths.locks, id);
    if (lockState(lock) === "mine" || !takeLock(lock)) continue;
    try {
      if (await recoverRun(ctx.db, id, runNote("interrupted"), budget)) report.recovered++;
      const session = getSession(ctx.db, id);
      if (session && session.closedAt === null && session.kind !== "interactive") {
        const last = latestRun(ctx.db, id);
        const reason =
          !last || last.endReason === "interrupted"
            ? "interrupted"
            : session.kind === "worker"
              ? "worker_finished"
              : "subagent_finished";
        if (await closeSession(ctx.db, id, reason, budget)) report.closed++;
      }
      if (oldArtifacts.has(id) && moveToTrash(ctx.paths.trash, join(ctx.paths.artifacts, id))) report.artifacts++;
    } finally {
      releaseLock(lock);
    }
  }
}

/**
 * Lock files: deleted once their session is closed. One with no session row is
 * deleted when its lock is free and it's over a day old (a session being created
 * takes its lock before its row exists)
 */
function cleanLockFiles(ctx: CleanupContext, report: CleanupReport): void {
  const now = ctx.now ?? Date.now();
  const files = entries(ctx.paths.locks).filter((e) => e.isFile() && e.name.endsWith(".lock"));
  const closed = closedStates(
    ctx.db,
    files.map((e) => e.name.slice(0, -".lock".length)),
  );
  for (const file of files) {
    const path = join(ctx.paths.locks, file.name);
    if (lockState(path) !== "free") continue;
    const state = closed.get(file.name.slice(0, -".lock".length));
    if (state === true || (state === undefined && modified(path) < now - LOCK_FILE_AGE)) {
      if (remove(path)) report.lockFiles++;
    }
  }
}

// ---- File steps (no database)

function cleanFiles(ctx: CleanupContext, report: CleanupReport): void {
  const now = ctx.now ?? Date.now();
  // Leftovers of interrupted work: half-installed runtimes, half-written backups
  for (const name of olderThan(ctx.paths.runtime, now - LEFTOVER_AGE, (e) => e.isDirectory() && e.name.startsWith(".tmp-"))) {
    if (moveToTrash(ctx.paths.trash, join(ctx.paths.runtime, name))) report.leftovers++;
  }
  for (const name of olderThan(ctx.paths.backups, now - LEFTOVER_AGE, (e) => e.isFile() && e.name.endsWith(".tmp"))) {
    if (remove(join(ctx.paths.backups, name))) report.leftovers++;
  }
  // Daily error logs past 30 days
  for (const name of olderThan(ctx.paths.logs, now - LOG_AGE, (e) => e.isFile() && /^protege-\d{4}-\d{2}-\d{2}\.log$/.test(e.name))) {
    if (remove(join(ctx.paths.logs, name))) report.logs++;
  }
  emptyTrash(ctx.paths.trash);
}

// ---- Helpers

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // not made yet
  }
}

/** Names in dir that match and were last changed before the cutoff */
function olderThan(dir: string, cutoff: number, match: (e: Dirent) => boolean): string[] {
  return entries(dir)
    .filter((e) => match(e) && modified(join(dir, e.name)) < cutoff)
    .map((e) => e.name);
}

function modified(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Infinity; // gone meanwhile: never old
  }
}

function remove(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false; // Windows: still open. Next time
  }
}