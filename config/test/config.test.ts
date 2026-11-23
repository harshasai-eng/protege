import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadApiKey, loadConfig } from "../load.ts";
import { protegePaths } from "../paths.ts";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  file = join(dir, "protege.yaml");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (text: string) => writeFile(file, text);

describe("loadConfig", () => {
  it("fills every default from just a model name", async () => {
    await write("model:\n  name: gpt-5.6\n");
    const config = await loadConfig(file);
    expect(config.model.name).toBe("gpt-5.6");
    expect(config.model.maxOutputTokens).toBe(25_000);
    expect(config.compaction.threshold).toBe(0.8);
    expect(config.loop.maxTurns).toBe(25);
    expect(config.cache.ttl).toBe("30m");
    expect(config.tools.readFile.defaultLimitLines).toBe(800);
    expect(config.permissions.defaultMode).toBe("ask");
  });

  it("keeps the values the file sets", async () => {
    await write("model:\n  name: gpt-5.6\nloop:\n  maxTurns: 40\n");
    expect((await loadConfig(file)).loop.maxTurns).toBe(40);
  });

  it("explains a missing file", async () => {
    await expect(loadConfig(file)).rejects.toThrow(/no config file/);
  });

  it("requires a model name", async () => {
    await write("loop:\n  maxTurns: 25\n");
    await expect(loadConfig(file)).rejects.toThrow(/model/);
  });

  it("rejects a key it doesn't know", async () => {
    await write("model:\n  name: gpt-5.6\nloop:\n  maxTurn: 25\n");
    await expect(loadConfig(file)).rejects.toThrow(/maxTurn/);
  });

  it("rejects a bad value, naming the setting", async () => {
    await write("model:\n  name: gpt-5.6\nloop:\n  maxTurns: 0\n");
    await expect(loadConfig(file)).rejects.toThrow(/loop\.maxTurns/);
  });

  it("checks settings that must agree", async () => {
    await write("model:\n  name: gpt-5.6\n  contextWindow: 20000\n  maxOutputTokens: 25000\n");
    await expect(loadConfig(file)).rejects.toThrow(/below model\.contextWindow/);
  });

  it("throws ConfigError, not a raw error", async () => {
    await write("model: [unclosed");
    await expect(loadConfig(file)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("loadApiKey", () => {
  const KEY = "PROTEGE_API_KEY";
  const saved = process.env[KEY];
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("prefers the environment", async () => {
    process.env[KEY] = "from-env";
    expect(await loadApiKey(join(dir, ".env"))).toBe("from-env");
  });

  it("reads ~/.protege/.env when it's private", async () => {
    const envFile = join(dir, ".env");
    await writeFile(envFile, `${KEY}=from-file\n`);
    await chmod(envFile, 0o600);
    expect(await loadApiKey(envFile)).toBe("from-file");
  });

  it.skipIf(process.platform === "win32")("refuses a .env other users can read", async () => {
    const envFile = join(dir, ".env");
    await writeFile(envFile, `${KEY}=from-file\n`);
    await chmod(envFile, 0o644);
    await expect(loadApiKey(envFile)).rejects.toThrow(/chmod 600/);
  });

  it("explains a missing key", async () => {
    await expect(loadApiKey(join(dir, ".env"))).rejects.toThrow(/No API key found/);
  });
});

describe("protegePaths", () => {
  it("puts everything under PROTEGE_HOME", () => {
    const paths = protegePaths("/tmp/ph");
    expect(paths.config).toBe(join("/tmp/ph", "protege.yaml"));
    expect(paths.logs).toBe(join("/tmp/ph", "logs"));
  });
});