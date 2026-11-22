import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { networkFilesystem, prepareHome } from "../src/storage/home.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const unix = process.platform !== "win32";

describe("prepareHome", () => {
  it("creates the folder", async () => {
    const home = join(dir, ".protege");
    expect(await prepareHome(home)).toEqual([]);
    expect((await stat(home)).isDirectory()).toBe(true);
  });

  it.skipIf(!unix)("creates it private", async () => {
    const home = join(dir, ".protege");
    await prepareHome(home);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!unix)("makes an existing open folder private", async () => {
    await chmod(dir, 0o755);
    await prepareHome(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("accepts a local folder", async () => {
    await expect(prepareHome(dir)).resolves.toEqual([]);
  });
});

describe("networkFilesystem", () => {
  it("names the network filesystems", () => {
    expect(networkFilesystem(0x6969)).toBe("NFS");
    expect(networkFilesystem(0xff534d42)).toBe("CIFS");
    expect(networkFilesystem(0x01021997)).toMatch(/WSL/);
  });

  it("reads a negative (signed) type number as unsigned", () => {
    expect(networkFilesystem(0xff534d42 | 0)).toBe("CIFS"); // | 0 makes it negative
  });

  it("passes local filesystems", () => {
    expect(networkFilesystem(0xef53)).toBeUndefined(); // ext4
    expect(networkFilesystem(0x01021994)).toBeUndefined(); // tmpfs
  });
});