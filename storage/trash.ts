import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";

// Every folder delete goes through the trash: a rename is instant and all-or-nothing
// where deleting file by file can stop halfway. The startup cleanup empties the trash later
// The trash sits in Protege's home folder, on the same drive as everything it holds

/** Moves a folder into the trash. False if it's gone already, or the move failed (Windows: a file inside is open) */
export function moveToTrash(trashDir: string, path: string): boolean {
  try {
    mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    renameSync(path, join(trashDir, uuidv7()));
    return true;
  } catch {
    return false; // tried again at the next cleanup
  }
}

/** Deletes what's in the trash. Anything that can't be deleted yet stays for next time */
export function emptyTrash(trashDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(trashDir);
  } catch {
    return; // no trash yet
  }
  for (const entry of entries) {
    try {
      rmSync(join(trashDir, entry), { recursive: true, force: true });
    } catch {
      // Windows: a file inside is still open
    }
  }
}