import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../../config/settings.ts";
import { openDatabase, type Storage } from "../../storage/db.ts";
import {
  createWorkflow,
  findWorkflow,
  listWorkflows,
  updateWorkflow,
  WorkflowError,
} from "../workflows.ts";

const config = configSchema.parse({ model: { name: "test-model" } });

let dir: string;
let storage: Storage;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "protege-test-"));
  storage = await openDatabase(join(dir, "protege.db"), config.storage);
});
afterEach(async () => {
  storage.close();
  await rm(dir, { recursive: true, force: true });
});

const create = (name: string, description = "Check receipts against the policy.") =>
  createWorkflow(storage.db, config, { name, description });

describe("workflows", () => {
  it("creates one and finds it by name, ignoring case", async () => {
    const created = await create("Expense audit");
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(findWorkflow(storage.db, "EXPENSE AUDIT")).toEqual(created);
  });

  it("lists them by name", async () => {
    await create("vendor onboarding");
    await create("Expense audit");
    expect(listWorkflows(storage.db).map((w) => w.name)).toEqual(["Expense audit", "vendor onboarding"]);
  });

  it("refuses a duplicate name, ignoring case", async () => {
    await create("Expense audit");
    await expect(create("expense AUDIT")).rejects.toThrow(/already a workflow/);
  });

  it("trims names, and refuses an empty one", async () => {
    expect((await create("  Expense audit  ")).name).toBe("Expense audit");
    await expect(create("   ")).rejects.toThrow(WorkflowError);
  });

  it("refuses a description over the limit", async () => {
    await expect(create("Long", "x".repeat(500 * 4 + 1))).rejects.toThrow(/too long \(about 501 tokens/);
  });

  it("renames, keeping the description", async () => {
    const w = await create("Expense audit");
    const updated = await updateWorkflow(storage.db, config, w.id, { name: "Monthly expense audit" });
    expect(updated.name).toBe("Monthly expense audit");
    expect(updated.description).toBe(w.description);
    expect(findWorkflow(storage.db, "Expense audit")).toBeUndefined();
  });

  it("edits the description, keeping the name", async () => {
    const w = await create("Expense audit");
    const updated = await updateWorkflow(storage.db, config, w.id, { description: "Check every receipt." });
    expect(updated.name).toBe("Expense audit");
    expect(findWorkflow(storage.db, "Expense audit")?.description).toBe("Check every receipt.");
  });

  it("changes only the case of its own name", async () => {
    const w = await create("Expense audit");
    expect((await updateWorkflow(storage.db, config, w.id, { name: "Expense Audit" })).name).toBe("Expense Audit");
  });

  it("refuses a rename onto another workflow's name", async () => {
    await create("Expense audit");
    const other = await create("Vendor onboarding");
    await expect(updateWorkflow(storage.db, config, other.id, { name: "expense audit" })).rejects.toThrow(
      /already a workflow/,
    );
  });

  it("says when the workflow doesn't exist", async () => {
    await expect(updateWorkflow(storage.db, config, "missing", { name: "x" })).rejects.toThrow(/doesn't exist/);
  });
});