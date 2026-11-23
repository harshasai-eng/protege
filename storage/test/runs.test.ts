import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../../config/settings.ts";
import { openDatabase, type Storage } from "../db.ts";
import { endRun, loadItems, type NewItem, recoverRun, RunError, saveItems, startRun, unfinishedRun } from "../runs.ts";
import { runs, sessions } from "../schema.ts";
import { createSession, type NewSession, type SessionStore } from "../sessions.ts";
import { createWorkflow } from "../workflows.ts";

const config = configSchema.parse({ model: { name: "test-model" } });
const budget = config.storage.runWriteBudgetMs;

let dir: string;
let storage: Storage;
let store: SessionStore;
let workflowId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  storage = await openDatabase(join(dir, "protege.db"), config.storage);
  store = { db: storage.db, locksDir: join(dir, "locks"), storage: config.storage };
  workflowId = (await createWorkflow(storage.db, { name: "Expense audit", description: "d" }, budget)).id;
});
afterEach(async () => {
  storage.close();
  await rm(dir, { recursive: true, force: true });
});

const newSession = (overrides: Partial<NewSession> = {}) =>
  createSession(store, {
    workflowId,
    kind: "interactive",
    cwd: join(dir, "project"),
    setup: { instructions: "You are Protege.", tools: [] },
    ...overrides,
  });

const message = (text: string): NewItem => ({ itemType: "message:user", itemJson: { role: "user", content: text } });
const note = (text: string): NewItem => ({ itemType: "pg:run_note", itemJson: { text } });
const call = (callId: string): NewItem => ({ itemType: "function_call", itemJson: { name: "read_file" }, callId });
const output = (callId: string): NewItem => ({ itemType: "function_call_output", itemJson: { output: "ok" }, callId });

const sessionRow = (id: string) => storage.db.select().from(sessions).where(eq(sessions.id, id)).get()!;
const runRows = (id: string) => storage.db.select().from(runs).where(eq(runs.sessionId, id)).all();
const types = (id: string) => loadItems(storage.db, id).map((i) => i.itemType);

describe("a run", () => {
  it("starts with its row and the user's message, after the setup", async () => {
    const s = await newSession();
    const run = await startRun(storage.db, s.id, [message("Check March")], budget);
    expect(run).toBe(1);
    expect(types(s.id)).toEqual(["pg:agent_setup", "message:user"]);
    expect(loadItems(storage.db, s.id)[1]).toMatchObject({ seq: 2, runIndex: 1 });
    expect(unfinishedRun(storage.db, s.id)).toMatchObject({ runIndex: 1, endedAt: null, turnCount: 0 });
  });

  it("saves items as they complete, and counts model responses as turns", async () => {
    const s = await newSession();
    const run = await startRun(storage.db, s.id, [message("Check March")], budget);
    expect(await saveItems(storage.db, s.id, run, [call("c1"), call("c2")], budget, { response: true })).toEqual([3, 4]);
    expect(await saveItems(storage.db, s.id, run, [output("c1")], budget)).toEqual([5]);
    expect(await saveItems(storage.db, s.id, run, [output("c2")], budget)).toEqual([6]);
    expect(unfinishedRun(storage.db, s.id)?.turnCount).toBe(1);
    expect(types(s.id)).toEqual(["pg:agent_setup", "message:user", "function_call", "function_call", "function_call_output", "function_call_output"]);
  });

  it("marks the session as used when it writes history", async () => {
    const s = await newSession();
    const before = sessionRow(s.id).lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await startRun(storage.db, s.id, [message("Check March")], budget);
    expect(sessionRow(s.id).lastActivityAt).toBeGreaterThan(before);
  });

  it("refuses a second run while one is going, and numbers the next one after it ends", async () => {
    const s = await newSession();
    const run = await startRun(storage.db, s.id, [message("one")], budget);
    await expect(startRun(storage.db, s.id, [message("two")], budget)).rejects.toThrow(RunError);
    await endRun(storage.db, s.id, run, { reason: "completed" }, budget);
    expect(await startRun(storage.db, s.id, [message("two")], budget)).toBe(2);
  });

  it("ends with its note, once", async () => {
    const s = await newSession();
    const run = await startRun(storage.db, s.id, [message("Check March")], budget);
    await endRun(storage.db, s.id, run, { reason: "cancelled", note: note("The previous run was stopped.") }, budget);
    expect(runRows(s.id)[0]).toMatchObject({ endReason: "cancelled" });
    expect(types(s.id).at(-1)).toBe("pg:run_note");
    expect(sessionRow(s.id).closedAt).toBeNull(); // an interactive session stays open
    await expect(endRun(storage.db, s.id, run, { reason: "completed" }, budget)).rejects.toThrow(RunError);
  });

  it("refuses items for a run that has ended", async () => {
    const s = await newSession();
    const run = await startRun(storage.db, s.id, [message("Check March")], budget);
    await endRun(storage.db, s.id, run, { reason: "completed" }, budget);
    await expect(saveItems(storage.db, s.id, run, [output("c1")], budget)).rejects.toThrow(RunError);
  });

  it("closes a worker's session in the same write as its end", async () => {
    const s = await newSession({ kind: "worker" });
    const run = await startRun(storage.db, s.id, [message("Check March")], budget);
    await endRun(storage.db, s.id, run, { reason: "completed", closeSession: "worker_finished" }, budget);
    expect(sessionRow(s.id)).toMatchObject({ closeReason: "worker_finished" });
    await expect(startRun(storage.db, s.id, [message("again")], budget)).rejects.toThrow(/closed/);
  });
});

describe("recoverRun", () => {
  it("ends an unfinished run as interrupted, with its note, leaving the session open", async () => {
    const s = await newSession();
    const run = await startRun(storage.db, s.id, [message("Check March")], budget);
    await saveItems(storage.db, s.id, run, [call("c1")], budget, { response: true });
    const lastActivity = sessionRow(s.id).lastActivityAt;
    expect(await recoverRun(storage.db, s.id, note("The previous run was interrupted."), budget)).toBe(true);
    expect(runRows(s.id)[0]).toMatchObject({ endReason: "interrupted" });
    expect(types(s.id).at(-1)).toBe("pg:run_note");
    expect(sessionRow(s.id)).toMatchObject({ closedAt: null, lastActivityAt: lastActivity });
  });

  it("closes the session's open sub-agent sessions and ends their runs", async () => {
    const parent = await newSession();
    await startRun(storage.db, parent.id, [message("Check March")], budget);
    const sub = await newSession({ kind: "subagent", parent: { sessionId: parent.id, callId: "c1" } });
    await startRun(storage.db, sub.id, [{ itemType: "message:task", itemJson: { text: "Read receipts" } }], budget);
    await recoverRun(storage.db, parent.id, note("interrupted"), budget);
    expect(sessionRow(sub.id)).toMatchObject({ closeReason: "interrupted" });
    expect(runRows(sub.id)[0]).toMatchObject({ endReason: "interrupted" });
  });

  it("does nothing the second time, or when nothing was left unfinished", async () => {
    const s = await newSession();
    expect(await recoverRun(storage.db, s.id, note("interrupted"), budget)).toBe(false);
    await startRun(storage.db, s.id, [message("Check March")], budget);
    expect(await recoverRun(storage.db, s.id, note("interrupted"), budget)).toBe(true);
    expect(await recoverRun(storage.db, s.id, note("interrupted"), budget)).toBe(false);
    expect(types(s.id).filter((t) => t === "pg:run_note")).toHaveLength(1);
  });
});

describe("loadItems", () => {
  it("returns items in order, from a seq on", async () => {
    const s = await newSession();
    const run = await startRun(storage.db, s.id, [message("one")], budget);
    await saveItems(storage.db, s.id, run, [call("c1"), output("c1")], budget);
    expect(loadItems(storage.db, s.id).map((i) => i.seq)).toEqual([1, 2, 3, 4]);
    expect(loadItems(storage.db, s.id, 3).map((i) => i.seq)).toEqual([3, 4]);
  });
});