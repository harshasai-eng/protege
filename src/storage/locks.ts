import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname } from "node:path";
import { tryLock, unlock } from "fs-native-extensions";

// OS file locks: freed when the process exits or is killed, kept while it's paused.
// Every lock this process holds, by path. Holding the descriptors here also stops
// garbage collection from closing one, which would silently drop its lock
const held = new Map<string, number>();

/** One try at a lock. True if this process now holds it */
export function takeLock(file: string): boolean {
  // A second handle on our own lock reads as "busy", so never open one
  if (held.has(file)) throw new Error(`This process already holds ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a+"); // writable: an exclusive lock needs it
  let granted = false;
  try {
    granted = tryLock(fd);
  } finally {
    if (!granted) closeSync(fd);
  }
  if (granted) held.set(file, fd);
  return granted;
}

/** Tries every pollMs until the lock is taken. Doesn't block the process while waiting */
export async function waitForLock(
  file: string,
  options: { signal?: AbortSignal; pollMs?: number; noticeAfterMs?: number; onNotice?: () => void } = {},
): Promise<void> {
  const { signal, pollMs = 100, noticeAfterMs = 1_000, onNotice } = options;
  const start = Date.now();
  let noticed = false;
  while (!takeLock(file)) {
    if (!noticed && onNotice && Date.now() - start >= noticeAfterMs) {
      noticed = true;
      onNotice();
    }
    await sleep(pollMs, undefined, { signal }); // rejects with AbortError when aborted
  }
}

/** Lets go of a lock this process holds */
export function releaseLock(file: string): void {
  const fd = held.get(file);
  if (fd === undefined) return;
  held.delete(file);
  try {
    unlock(fd);
  } finally {
    closeSync(fd);
  }
}

/** Who holds a lock, without taking it and without creating the file */
export function lockState(file: string): "mine" | "taken" | "free" {
  if (held.has(file)) return "mine";
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "free";
    throw err;
  }
  try {
    // A shared lock conflicts only with an exclusive one: granted means nobody holds it
    if (!tryLock(fd, { shared: true })) return "taken";
    unlock(fd);
    return "free";
  } finally {
    closeSync(fd);
  }
}

/** Deletes a lock file this process doesn't hold. Errors are ignored (in use, or already gone) */
export function deleteLockFile(file: string): void {
  if (held.has(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // Windows refuses to delete a file another process has open; a later cleanup retries
  }
}