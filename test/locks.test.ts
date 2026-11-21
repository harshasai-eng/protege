import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteLockFile, lockState, releaseLock, takeLock, waitForLock } from "../src/storage/locks.ts";

let dir: string;
let file: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  file = join(dir, "locks", "s1.lock");
});
afterEach(async () => {
  releaseLock(file);
  for (const child of children.splice(0)) await kill(child);
  await rm(dir, { recursive: true, force: true });
});

// Another process that takes the lock and keeps it until killed
async function holdInChild(path: string): Promise<ChildProcess> {
  const child = fork(join(import.meta.dirname, "fixtures", "hold-lock.ts"), [path]);
  children.push(child);
  expect(await new Promise((resolve) => child.once("message", resolve))).toBe("held");
  return child;
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

describe("locks", () => {
  it("takes, reports and releases a lock", () => {
    expect(lockState(file)).toBe("free");
    expect(takeLock(file)).toBe(true);
    expect(lockState(file)).toBe("mine");
    releaseLock(file);
    expect(lockState(file)).toBe("free");
  });

  it("refuses a second handle on a lock this process holds", () => {
    takeLock(file);
    expect(() => takeLock(file)).toThrow(/already holds/);
  });

  it("sees another process's lock, and gets it once that process is killed", async () => {
    const child = await holdInChild(file);
    expect(lockState(file)).toBe("taken");
    expect(takeLock(file)).toBe(false);
    await kill(child);
    expect(takeLock(file)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps the lock while the holder is paused", async () => {
    const child = await holdInChild(file);
    child.kill("SIGSTOP");
    expect(lockState(file)).toBe("taken");
  });

  it("waits for a lock without blocking, with a notice", async () => {
    const child = await holdInChild(file);
    let noticed = false;
    const waiting = waitForLock(file, { pollMs: 20, noticeAfterMs: 50, onNotice: () => (noticed = true) });
    await new Promise((resolve) => setTimeout(resolve, 150)); // timers still run while it waits
    await kill(child);
    await waiting;
    expect(noticed).toBe(true);
    expect(lockState(file)).toBe("mine");
  });

  it("stops waiting when cancelled", async () => {
    await holdInChild(file);
    const controller = new AbortController();
    const waiting = waitForLock(file, { signal: controller.signal, pollMs: 20 });
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/i);
  });

  it("checks without creating the file, and deletes only files it doesn't hold", () => {
    expect(lockState(file)).toBe("free");
    expect(existsSync(file)).toBe(false);
    takeLock(file);
    deleteLockFile(file);
    expect(existsSync(file)).toBe(true);
    releaseLock(file);
    deleteLockFile(file);
    expect(existsSync(file)).toBe(false);
  });
});