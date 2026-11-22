import { type ChildProcess, fork } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config/settings.ts";
import { openDatabase, type Storage } from "../src/storage/db.ts";
import { lockState } from "../src/storage/locks.ts";
import { items } from "../src/storage/schema.ts";
import {
  continueLatest,
  createSession,
  listSessions,
  markOutcome,
  type NewSession,
  releaseSession,
  resumeSession,
  type SessionStore,
  sessionLockFile,
} from "../src/storage/sessions.ts";
import { createWorkflow } from "../src/storage/workflows.ts";

const config = configSchema.parse({ model: { name: "test-model" } });

let dir: string;
let storage: Storage;
let store: SessionStore;
let workflowId: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  storage = await openDatabase(join(dir, "protege.db"), config.storage);
  store = { db: storage.db, locksDir: join(dir, "locks"), storage: config.storage };
  workflowId = createWorkflow(storage.db, config, { name: "Expense audit", description: "d" }).id;
});
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  storage.close();
  await rm(dir, { recursive: true, force: true });
});

const project = () => join(dir, "project");
const newSession = (overrides: Partial<NewSession> = {}) =>
  createSession(store, {
    workflowId,
    kind: "interactive",
    cwd: project(),
    setup: { instructions: "You are Protege.", tools: [] },
    ...overrides,
  });

// Another process holding a session's lock, like a second Protege window
async function holdInChild(id: string) {
  child = fork(join(import.meta.dirname, "fixtures", "hold-lock.ts"), [sessionLockFile(store.locksDir, id)]);
  expect(await new Promise((resolve) => child!.once("message", resolve))).toBe("held");
}

// As if this process had exited: let go of the session
const leave = (id: string) => releaseSession(store.locksDir, id);

describe("createSession", () => {
  it("takes the lock, then writes the row and its setup", async () => {
    const s = await newSession();
    expect(lockState(sessionLockFile(store.locksDir, s.id))).toBe("mine");
    const setup = storage.db.select().from(items).all();
    expect(setup).toMatchObject([{ sessionId: s.id, seq: 1, itemType: "pg:agent_setup" }]);
  });

  it("releases and deletes the lock when the row can't be written", async () => {
    await expect(newSession({ workflowId: "missing" })).rejects.toThrow(/FOREIGN KEY/);
    expect(readdirSync(store.locksDir)).toEqual([]);
  });
});

describe("resumeSession", () => {
  it("resumes an open session that nobody has", async () => {
    const s = await newSession();
    leave(s.id);
    expect((await resumeSession(store, s.id, project())).id).toBe(s.id);
    expect(lockState(sessionLockFile(store.locksDir, s.id))).toBe("mine");
  });

  it("refuses a session open in another window, after retrying for 2 seconds", async () => {
    const s = await newSession();
    leave(s.id);
    await holdInChild(s.id);
    const start = Date.now();
    await expect(resumeSession(store, s.id, project())).rejects.toThrow(/open in another Protege window/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(1_900);
  });

  it("resumes once the other window is gone, even after kill -9", async () => {
    const s = await newSession();
    leave(s.id);
    await holdInChild(s.id);
    child!.kill("SIGKILL");
    await new Promise((resolve) => child!.once("exit", resolve));
    expect((await resumeSession(store, s.id, project())).id).toBe(s.id);
  });

  it("refuses its own session, a closed one, a worker's, another folder's, and a missing one", async () => {
    const own = await newSession();
    await expect(resumeSession(store, own.id, project())).rejects.toThrow(/already open in this window/);

    await markOutcome(store, own.id, "successful", null);
    await expect(resumeSession(store, own.id, project())).rejects.toThrow(/closed/);

    const worker = await newSession({ kind: "worker" });
    leave(worker.id);
    await expect(resumeSession(store, worker.id, project())).rejects.toThrow(/Only interactive/);

    const elsewhere = await newSession();
    leave(elsewhere.id);
    await expect(resumeSession(store, elsewhere.id, dir)).rejects.toThrow(/belongs to/);
    expect(lockState(sessionLockFile(store.locksDir, elsewhere.id))).toBe("free"); // refused: let go

    await expect(resumeSession(store, "missing", project())).rejects.toThrow(/no session/);
  });
});

describe("continueLatest", () => {
  it("picks the latest open interactive session in the folder", async () => {
    const older = await newSession();
    leave(older.id);
    const newer = await newSession();
    leave(newer.id);
    expect((await continueLatest(store, project())).id).toBe(newer.id);
  });

  it("refuses when the latest is open elsewhere, rather than picking another", async () => {
    const older = await newSession();
    leave(older.id);
    const newer = await newSession();
    leave(newer.id);
    await holdInChild(newer.id);
    await expect(continueLatest(store, project())).rejects.toThrow(/open in another Protege window/);
  });

  it("says when there's nothing to continue", async () => {
    await expect(continueLatest(store, project())).rejects.toThrow(/no open session/);
  });
});

describe("listSessions and markOutcome", () => {
  it("lists this folder's sessions, newest first, without sub-agents", async () => {
    const older = await newSession();
    const newer = await newSession();
    await newSession({ kind: "subagent", parent: { sessionId: older.id, callId: "call_1" } });
    expect(listSessions(store, project()).map((s) => s.id)).toEqual([newer.id, older.id]);
  });

  it("marking closes the session and lets it go", async () => {
    const s = await newSession();
    await markOutcome(store, s.id, "failed", "Wrong totals");
    expect(listSessions(store, project())[0]).toMatchObject({ outcome: "failed", closeReason: "marked" });
    expect(lockState(sessionLockFile(store.locksDir, s.id))).toBe("free");
  });
});