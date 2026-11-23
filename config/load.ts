import { readFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { protegePaths } from "./paths.ts";
import { configSchema, type Config } from "./settings.ts";

/** A config or API key problem, worded for the user */
export class ConfigError extends Error {
  override name = "ConfigError";
}

// The environment variable that holds the API key
export const API_KEY_ENV = "PROTEGE_API_KEY";

/** Reads and checks protege.yaml. Called once when a session opens or resumes */
export async function loadConfig(file: string = protegePaths().config): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      throw new ConfigError(
        `There's no config file at ${file}. Create it with at least:\n\nmodel:\n  name: <model ID, GPT-5.6 or later>`,
      );
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    throw new ConfigError(`${file} isn't valid YAML: ${(err as Error).message}`);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`${file} has problems:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** The API key: from the environment first, then ~/.protege/.env (readable only by the user) */
export async function loadApiKey(envFile: string = protegePaths().envFile): Promise<string> {
  const name = API_KEY_ENV;
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;

  let text: string;
  try {
    text = await readFile(envFile, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      throw new ConfigError(`No API key found. Set ${name} in your environment, or add it to ${envFile}.`);
    }
    throw err;
  }

  // macOS and Linux: refuse a key file other users can read
  if (process.platform !== "win32") {
    const { mode } = await stat(envFile);
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(`${envFile} can be read by other users. Run: chmod 600 ${envFile}`);
    }
  }

  const value = parseEnv(text)[name];
  if (!value) {
    throw new ConfigError(`${envFile} has no ${name}. Add a line: ${name}=<your key>`);
  }
  return value;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}