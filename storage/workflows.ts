import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { type Db, retryBusy, write } from "./db.ts";
import { workflows } from "./schema.ts";

export type Workflow = typeof workflows.$inferSelect;

/** A workflow problem, worded for the user */
export class WorkflowError extends Error {
  override name = "WorkflowError";
}

/** Saves a new workflow. The engine checks the name and description first */
export async function createWorkflow(
  db: Db,
  input: { name: string; description: string },
  budgetMs: number,
): Promise<Workflow> {
  const { name, description } = input;
  const now = Date.now();
  const row: Workflow = { id: uuidv7(), name, description, createdAt: now, updatedAt: now };
  await retryBusy(() => saving(name, () => write(db, (tx) => tx.insert(workflows).values(row).run())), budgetMs);
  return row;
}

/** Every workflow, by name */
export function listWorkflows(db: Db): Workflow[] {
  return db.select().from(workflows).orderBy(sql`lower(${workflows.name})`).all();
}

/** By name, ignoring case */
export function findWorkflow(db: Db, name: string): Workflow | undefined {
  return db
    .select()
    .from(workflows)
    .where(sql`lower(${workflows.name}) = lower(${name.trim()})`)
    .get();
}

/** Renames a workflow or edits its description. Writes only what changed */
export async function updateWorkflow(
  db: Db,
  id: string,
  changes: { name?: string; description?: string },
  budgetMs: number,
): Promise<Workflow> {
  const { name } = changes;
  // One UPDATE ... RETURNING: columns left undefined aren't written, so an
  // edit made meanwhile by another Protege to the other column isn't lost
  return retryBusy(
    () =>
      saving(name ?? "", () =>
        write(db, (tx) => {
          const set = { name, description: changes.description, updatedAt: Date.now() };
          const updated = tx.update(workflows).set(set).where(eq(workflows.id, id)).returning().get();
          if (!updated) throw new WorkflowError("That workflow doesn't exist.");
          return updated;
        }),
      ),
    budgetMs,
  );
}

// The unique index on lower(name) is the duplicate check: it holds even when
// two Protege processes save at once. Its error becomes a sentence for the user
function saving<T>(name: string, save: () => T): T {
  try {
    return save();
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new WorkflowError(`There's already a workflow named "${name}".`);
    }
    throw err;
  }
}