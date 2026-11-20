import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logError } from "../src/errorLog.ts";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  file = join(dir, "logs", "protege.log");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("logError", () => {
  it("writes the context and the stack, creating the logs folder", async () => {
    await logError("session s_1, run 2", new Error("disk full"), file);
    const log = await readFile(file, "utf8");
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T.* protege \S+ session s_1, run 2\n/);
    expect(log).toContain("Error: disk full");
    expect(log).toContain("errorLog.test.ts"); // a line of the stack
  });

  it("appends, keeping earlier entries", async () => {
    await logError("first", new Error("one"), file);
    await logError("second", new Error("two"), file);
    const log = await readFile(file, "utf8");
    expect(log.indexOf("one")).toBeLessThan(log.indexOf("two"));
  });

  it("includes the cause", async () => {
    await logError("run", new Error("run failed", { cause: new Error("socket closed") }), file);
    expect(await readFile(file, "utf8")).toContain("socket closed");
  });

  it.skipIf(process.platform === "win32")("is readable only by the user", async () => {
    await logError("run", new Error("x"), file);
    expect((await stat(file)).mode & 0o077).toBe(0);
  });

  it("never throws, even when it can't write", async () => {
    const blocked = join(dir, "a-file");
    await writeFile(blocked, "");
    await expect(logError("run", new Error("x"), join(blocked, "protege.log"))).resolves.toBeUndefined();
  });
});