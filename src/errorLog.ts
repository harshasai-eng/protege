import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { inspect } from "node:util";
import { protegePaths } from "./config/paths.ts";
import { HARNESS_VERSION } from "./version.ts";

/** Appends an error to ~/.protege/logs/protege.log. Never throws */
export async function logError(
  context: string,
  err: unknown,
  file: string = protegePaths().errorLog,
): Promise<void> {
  // inspect: the stack, the error's code and any cause
  const entry = `${new Date().toISOString()} protege ${HARNESS_VERSION} ${context}\n${inspect(err)}\n\n`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, entry, { mode: 0o600 });
  } catch {
    // A failed log write must not become a second error
  }
}