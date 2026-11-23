import { and, eq, gte, isNull, max, sql } from "drizzle-orm";
import { type Db, retryBusy, type Tx, write } from "./db.ts";
import { items, runs, sessions } from "./schema.ts";

// Runs and their items. Every function here is one write, and each item is
// saved as it completes (the engine decides when). The caller holds the
// session's lock, so no other process writes to this session meanwhile

export type Run = typeof runs.$inferSelect;
export type Item = typeof items.$inferSelect;
export type EndReason = NonNullable<Run["endReason"]>;
export type CloseReason = NonNullable<(typeof sessions.$inferSelect)["closeReason"]>;

/** An item to save; its session, run, seq and time are filled in here */
export interface NewItem {
  itemType: string;
  itemJson: unknown;
  meta?: Record<string, unknown> | null;
  turnIndex?: number | null;
  callId?: string | null;
  providerResponseId?: string | null;
  usage?: Record<string, unknown> | null;
  callSettings?: Record<string, unknown> | null;
}

/** A run problem, worded for the user */
export class RunError extends Error {
  override name = "RunError";
}

/**
 * Starts a run: its row and its first items (the user's message), in one write.
 * Returns the new run's index. Refused while another run is going
 */
export async function startRun(db: Db, sessionId: string, first: NewItem[], budgetMs: number): Promise<number> {
  return retryBusy(
    () =>
      write(db, (tx) => {
        const open = tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)))
          .get();
        if (!open) throw new RunError("This session is closed.");
        // The runs_active index refuses a second run too; this says it in words
        if (unfinishedRun(tx, sessionId)) throw new RunError("A run is already in progress in this session.");
        const now = Date.now();
        const last = tx.select({ n: max(runs.runIndex) }).from(runs).where(eq(runs.sessionId, sessionId)).get();
        const runIndex = (last?.n ?? 0) + 1;
        tx.insert(runs).values({ sessionId, runIndex, startedAt: now }).run();
        insertItems(tx, sessionId, runIndex, first, now);
        touch(tx, sessionId, now);
        return runIndex;
      }),
    budgetMs,
  );
}

/**
 * Saves items of a run that's still going, in one write, and returns their seqs.
 * response: these are a model response's items, so the run's turn count goes up
 */
export async function saveItems(
  db: Db,
  sessionId: string,
  runIndex: number,
  list: NewItem[],
  budgetMs: number,
  options: { response?: boolean } = {},
): Promise<number[]> {
  return retryBusy(
    () =>
      write(db, (tx) => {
        const run = unfinishedRun(tx, sessionId);
        if (run?.runIndex !== runIndex) throw new RunError("That run has already ended.");
        const now = Date.now();
        const seqs = insertItems(tx, sessionId, runIndex, list, now);
        if (options.response) {
          tx.update(runs)
            .set({ turnCount: sql`${runs.turnCount} + 1` })
            .where(and(eq(runs.sessionId, sessionId), eq(runs.runIndex, runIndex)))
            .run();
        }
        touch(tx, sessionId, now);
        return seqs;
      }),
    budgetMs,
  );
}

/**
 * Ends a run, in one write: its note (when it didn't complete), its end time and
 * reason, and, for a worker or sub-agent, the session's close
 */
export async function endRun(
  db: Db,
  sessionId: string,
  runIndex: number,
  end: { reason: EndReason; note?: NewItem; closeSession?: CloseReason },
  budgetMs: number,
): Promise<void> {
  await retryBusy(
    () =>
      write(db, (tx) => {
        const now = Date.now();
        const ended = tx
          .update(runs)
          .set({ endedAt: now, endReason: end.reason })
          .where(and(eq(runs.sessionId, sessionId), eq(runs.runIndex, runIndex), isNull(runs.endedAt)))
          .run().changes;
        if (ended !== 1) throw new RunError("That run has already ended.");
        if (end.note) insertItems(tx, sessionId, runIndex, [end.note], now);
        if (end.closeSession) close(tx, sessionId, end.closeSession, now);
        touch(tx, sessionId, now);
      }),
    budgetMs,
  );
}

/**
 * Recovery, in one write: ends the session's unfinished run as interrupted, with
 * the note given, and closes the open sub-agent sessions it started (ending their
 * unfinished runs too). Checks inside its write, so a second call does nothing.
 * Leaves last_activity_at alone. True if anything changed
 */
export async function recoverRun(db: Db, sessionId: string, note: NewItem, budgetMs: number): Promise<boolean> {
  return retryBusy(
    () =>
      write(db, (tx) => {
        const now = Date.now();
        let changed = false;
        const run = unfinishedRun(tx, sessionId);
        if (run) {
          insertItems(tx, sessionId, run.runIndex, [note], now);
          interrupt(tx, sessionId, now);
          changed = true;
        }
        const children = tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.parentSessionId, sessionId), isNull(sessions.closedAt)))
          .all();
        for (const child of children) {
          interrupt(tx, child.id, now);
          close(tx, child.id, "interrupted", now);
          changed = true;
        }
        return changed;
      }),
    budgetMs,
  );
}

/** A session's items in order, from a seq on (all of them by default) */
export function loadItems(db: Db, sessionId: string, fromSeq = 1): Item[] {
  return db
    .select()
    .from(items)
    .where(and(eq(items.sessionId, sessionId), gte(items.seq, fromSeq)))
    .orderBy(items.seq)
    .all();
}

/** The session's run that hasn't ended, if any. Works inside a write too */
export function unfinishedRun(db: Db | Tx, sessionId: string): Run | undefined {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), isNull(runs.endedAt)))
    .get();
}

// ---- Inside a write

// Next seqs after the session's last item; safe because the write lock is held
function insertItems(tx: Tx, sessionId: string, runIndex: number, list: NewItem[], now: number): number[] {
  const last = tx.select({ n: max(items.seq) }).from(items).where(eq(items.sessionId, sessionId)).get();
  let seq = last?.n ?? 0;
  const seqs: number[] = [];
  for (const item of list) {
    seq += 1;
    tx.insert(items)
      .values({
        sessionId,
        seq,
        runIndex,
        createdAt: now,
        itemType: item.itemType,
        itemJson: item.itemJson,
        meta: item.meta ?? null,
        turnIndex: item.turnIndex ?? null,
        callId: item.callId ?? null,
        providerResponseId: item.providerResponseId ?? null,
        usage: item.usage ?? null,
        callSettings: item.callSettings ?? null,
      })
      .run();
    seqs.push(seq);
  }
  return seqs;
}

function interrupt(tx: Tx, sessionId: string, now: number): void {
  tx.update(runs)
    .set({ endedAt: now, endReason: "interrupted" })
    .where(and(eq(runs.sessionId, sessionId), isNull(runs.endedAt)))
    .run();
}

function close(tx: Tx, sessionId: string, reason: CloseReason, now: number): void {
  tx.update(sessions)
    .set({ closedAt: now, closeReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)))
    .run();
}

// Writes that add to a session's history mark it as used
function touch(tx: Tx, sessionId: string, now: number): void {
  tx.update(sessions).set({ lastActivityAt: now }).where(eq(sessions.id, sessionId)).run();
}