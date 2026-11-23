import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Rules about the codebase itself, checked by reading the source

const root = join(import.meta.dirname, "..");

// Calls point down: CLI → API → engine → infrastructure (storage, provider, shell, config)
const mayImport: Record<string, string[]> = {
  cli: ["cli", "api", "config"],
  api: ["api", "engine", "storage", "provider", "shell", "config"],
  engine: ["engine", "storage", "provider", "shell", "config"],
  storage: ["storage", "config"],
  provider: ["provider", "config"],
  shell: ["shell", "config"],
  config: ["config"],
};

/** Every source file (tests left out), as paths from the repo root */
async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const part of Object.keys(mayImport)) {
    const entries = await readdir(join(root, part), { recursive: true }).catch(() => [] as string[]);
    for (const f of entries) {
      const path = join(part, f);
      if (path.endsWith(".ts") && !path.split(sep).includes("test")) files.push(path);
    }
  }
  return files;
}

describe("the codebase", () => {
  it("only imports downward, between parts", async () => {
    for (const file of await sourceFiles()) {
      const part = file.split(sep)[0]!;
      const text = await readFile(join(root, file), "utf8");
      for (const [, spec] of text.matchAll(/from "(\.[^"]+)"/g)) {
        const target = relative(root, resolve(root, dirname(file), spec!)).split(sep)[0]!;
        expect(mayImport[part], `${file} imports ${spec}`).toContain(target);
      }
    }
  });

  it("starts transactions only in storage/db.ts", async () => {
    for (const file of await sourceFiles()) {
      if (file === join("storage", "db.ts")) continue;
      const text = await readFile(join(root, file), "utf8");
      expect(text, file).not.toMatch(/\.transaction\(|\bBEGIN\b/);
    }
  });
});