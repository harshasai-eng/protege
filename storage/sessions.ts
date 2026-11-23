import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { join, resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { Config } from "../config/settings.ts";
import { type Db, retryBusy, write } from "./db.ts";
import { deleteLockFile, lockState, releaseLock, takeLock, waitForLock } from "./locks.ts";
import { items, runs, sessionSkills, sessions } from "./schema.ts";

export type Session = typeof sessions.$inferSelect;

/** What session functions need: the database, the locks folder, the storage settings */
export interface SessionStore {
  db: Db;
  locksDir: string;
  storage: Config["storage"];
}

/** A session problem, worded for the user */
export class SessionError extends Error {
  override name = "SessionError";
}

const IN_USE = "This session is open in another Protege window. Close it there first.";

export function sessionLockFile(locksDir: string, id: string): string {
  return join(locksDir, `${id}.lock`);
}

export interface NewSession {
  workflowId: string;
  kind: "interactive" | "worker" | "subagent";
  cwd: string;
  parent?: { sessionId: string; callId: string }; // sub-agents only
  pins?: { skillId: string; skillVersionId: string }[];
  setup: { instructions: string; tools: unknown[] }; // pg:agent_setup
}

/**
 * Creates a session: its lock first, then, in one write, its row, its skill pins
 * and its setup (seq 1). The new id is unknown to anyone else, so the lock is free
 */
export async function createSession(
  store: SessionStore,
  input: NewSession,
  budgetMs: number = store.storage.writeBudgetMs,
): Promise<Session> {
  const now = Date.now();
  const row: Session = {
    id: uuidv7(),
    workflowId: input.workflowId,
    kind: input.kind,
    parentSessionId: input.parent?.sessionId ?? null,
    parentCallId: input.parent?.callId ?? null,
    cwd: resolve(input.cwd),
    startedAt: now,
    lastActivityAt: now,
    closedAt: null,
    closeReason: null,
    outcome: null,
    outcomeNote: null,
    outcomeAt: null,
  };
  const lock = sessionLockFile(store.locksDir, row.id);
  if (!takeLock(lock)) throw new Error(`The lock for new session ${row.id} is taken`);
  try {
    await retryBusy(
      () =>
        write(store.db, (tx) => {
          tx.insert(sessions).values(row).run();
          for (const pin of input.pins ?? []) tx.insert(sessionSkills).values({ sessionId: row.id, ...pin }).run();
          tx.insert(items)
            .values({ sessionId: row.id, seq: 1, createdAt: now, itemType: "pg:agent_setup", itemJson: input.setup })
            .run();
        }),
      budgetMs,
    );
  } catch (err) {
    // No row was written, so this lock file belongs to nothing
    releaseLock(lock);
    deleteLockFile(lock);
    throw err;
  }
  return row;
}

/**
 * Takes an interactive session to resume it, from its own folder. Retries the
 * lock for up to 2 s (a startup cleanup may hold it for a moment)
 */
export async function resumeSession(store: SessionStore, id: string, cwd: string): Promise<Session> {
  const lock = sessionLockFile(store.locksDir, id);
  if (lockState(lock) === "mine") throw new SessionError("This session is already open in this window.");
  if (!(await waitForLock(lock, { timeoutMs: 2_000 }))) throw new SessionError(IN_USE);
  const session = store.db.select().from(sessions).where(eq(sessions.id, id)).get();
  const refusal = whyNotResumable(session, id, cwd);
  if (refusal) {
    releaseSession(store.locksDir, id);
    throw new SessionError(refusal);
  }
  return session!;
}

function whyNotResumable(session: Session | undefined, id: string, cwd: string): string | undefined {
  if (!session) return `There's no session ${id}.`;
  if (session.closedAt !== null) return "This session is closed. Closed sessions can't be resumed.";
  if (session.kind !== "interactive") return "Only interactive sessions can be resumed.";
  if (session.cwd !== resolve(cwd)) return `This session belongs to ${session.cwd}. Resume it from that folder.`;
  return undefined;
}

/** --continue: the latest open interactive session in this folder. Refuses if it's open elsewhere */
export async function continueLatest(store: SessionStore, cwd: string): Promise<Session> {
  const latest = store.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.cwd, resolve(cwd)), eq(sessions.kind, "interactive"), isNull(sessions.closedAt)))
    .orderBy(desc(sessions.lastActivityAt), desc(sessions.id)) // ids are time-ordered: the tiebreak
    .get();
  if (!latest) throw new SessionError("There's no open session in this folder.");
  return resumeSession(store, latest.id, cwd);
}

/** This folder's sessions (not sub-agents), newest first */
export function listSessions(store: SessionStore, cwd: string): Session[] {
  return store.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.cwd, resolve(cwd)), ne(sessions.kind, "subagent")))
    .orderBy(desc(sessions.lastActivityAt), desc(sessions.id)) // ids are time-ordered: the tiebreak
    .all();
}

/** Marks an interactive session successful or failed, which closes it, then lets it go */
export async function markOutcome(
  store: SessionStore,
  id: string,
  outcome: "successful" | "failed",
  note: string | null,
  budgetMs: number = store.storage.writeBudgetMs,
): Promise<void> {
  if (lockState(sessionLockFile(store.locksDir, id)) !== "mine") {
    throw new Error(`Session ${id} isn't held by this process`);
  }
  const now = Date.now();
  await retryBusy(
    () =>
      write(store.db, (tx) => {
        const changed = tx
          .update(sessions)
          .set({ outcome, outcomeNote: note, outcomeAt: now, closedAt: now, closeReason: "marked" })
          .where(and(eq(sessions.id, id), eq(sessions.kind, "interactive"), isNull(sessions.closedAt)))
          .run().changes;
        if (changed !== 1) throw new SessionError("Only an open interactive session can be marked.");
      }),
    budgetMs,
  );
  releaseSession(store.locksDir, id);
}

/**
 * Lets a session go (exit, detach, a refused resume, shutdown, after marking).
 * Only releases the lock: the file stays, and the startup cleanup deletes it
 * once the session is closed
 */
export function releaseSession(locksDir: string, id: string): void {
  releaseLock(sessionLockFile(locksDir, id));
}

/** One session's row, if there is one */
export function getSession(db: Db, id: string): Session | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

/** Open sessions that may need recovering: every worker and sub-agent session, and any with an unfinished run */
export function sessionsToRecover(db: Db): string[] {
  return db
    .selectDistinct({ id: sessions.id })
    .from(sessions)
    .leftJoin(runs, and(eq(runs.sessionId, sessions.id), isNull(runs.endedAt)))
    .where(and(isNull(sessions.closedAt), or(ne(sessions.kind, "interactive"), isNotNull(runs.sessionId))))
    .all()
    .map((row) => row.id);
}

/** For each id that has a row: whether that session is closed */
export function closedStates(db: Db, ids: string[]): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = db
      .select({ id: sessions.id, closedAt: sessions.closedAt })
      .from(sessions)
      .where(inArray(sessions.id, ids.slice(i, i + 500)))
      .all();
    for (const row of rows) found.set(row.id, row.closedAt !== null);
  }
  return found;
}

/** Closes an open session (a worker's or sub-agent's, after a crash). True if it was open */
export async function closeSession(
  db: Db,
  id: string,
  reason: "worker_finished" | "subagent_finished" | "interrupted",
  budgetMs: number,
): Promise<boolean> {
  return retryBusy(
    () =>
      write(db, (tx) => {
        const now = Date.now();
        return (
          tx
            .update(sessions)
            .set({ closedAt: now, closeReason: reason })
            .where(and(eq(sessions.id, id), isNull(sessions.closedAt)))
            .run().changes === 1
        );
      }),
    budgetMs,
  );
}