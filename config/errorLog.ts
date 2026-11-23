import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { protegePaths } from "./paths.ts";
import { HARNESS_VERSION } from "./version.ts";

/** The day's log file: logs/protege-YYYY-MM-DD.log, by UTC date like the timestamps inside */
export function logFile(logsDir: string, now: Date): string {
  return join(logsDir, `protege-${now.toISOString().slice(0, 10)}.log`);
}

/**
 * Appends an error to today's log file. Every Protege process shares it. Never throws.
 * Synchronous: an exit right after (shutdown deadline, a second signal) can't drop the entry
 */
export function logError(
  context: string,
  err: unknown,
  logsDir: string = protegePaths().logs,
  now: Date = new Date(),
): void {
  // inspect: the stack, the error's code and any cause, in one string
  const entry = `${now.toISOString()} protege ${HARNESS_VERSION} ${context}\n${inspect(err)}\n\n`;
  try {
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(logFile(logsDir, now), entry, { mode: 0o600 });
  } catch {
    // A failed log write must not become a second error
  }
}