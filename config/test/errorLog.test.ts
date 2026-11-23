import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logError, logFile } from "../errorLog.ts";

let dir: string;
let logs: string;
const day = new Date("2026-11-22T15:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "protege-test-"));
  logs = join(dir, "logs");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (now: Date) => readFileSync(logFile(logs, now), "utf8");

describe("logError", () => {
  it("writes the context and the stack to the day's file, creating the logs folder", () => {
    logError("session s_1, run 2", new Error("disk full"), logs, day);
    expect(logFile(logs, day)).toBe(join(logs, "protege-2026-11-22.log"));
    const log = read(day);
    expect(log).toMatch(/^2026-11-22T15:00:00\.000Z protege \S+ session s_1, run 2\n/);
    expect(log).toContain("Error: disk full");
    expect(log).toContain("errorLog.test.ts"); // a line of the stack
  });

  it("has written the entry by the time it returns", () => {
    logError("run", new Error("written already"), logs, day);
    expect(read(day)).toContain("written already"); // no await: an exit here would keep it
  });

  it("appends, keeping earlier entries", () => {
    logError("first", new Error("one"), logs, day);
    logError("second", new Error("two"), logs, day);
    const log = read(day);
    expect(log.indexOf("one")).toBeLessThan(log.indexOf("two"));
  });

  it("starts the next day's file after midnight (UTC)", () => {
    const before = new Date("2026-11-22T23:59:59Z");
    const after = new Date("2026-11-23T00:00:01Z");
    logError("late", new Error("one"), logs, before);
    logError("early", new Error("two"), logs, after);
    expect(read(before)).toContain("one");
    expect(read(after)).toContain("two");
    expect(read(after)).not.toContain("one");
  });

  it("includes the cause", () => {
    logError("run", new Error("run failed", { cause: new Error("socket closed") }), logs, day);
    expect(read(day)).toContain("socket closed");
  });

  it.skipIf(process.platform === "win32")("is readable only by the user", () => {
    logError("run", new Error("x"), logs, day);
    expect(statSync(logFile(logs, day)).mode & 0o077).toBe(0);
  });

  it("never throws, even when it can't write", () => {
    const blocked = join(dir, "a-file");
    writeFileSync(blocked, "");
    expect(() => logError("run", new Error("x"), join(blocked, "logs"), day)).not.toThrow();
  });
});