import type { Config } from "../config/settings.ts";
import type { Db } from "../storage/db.ts";
import * as stored from "../storage/workflows.ts";
import { type Workflow, WorkflowError } from "../storage/workflows.ts";
import { estimateTokens } from "./context/estimate.ts";

// Workflow rules (name, description size); storage only saves and finds
export { findWorkflow, listWorkflows, type Workflow, WorkflowError } from "../storage/workflows.ts";

export async function createWorkflow(
  db: Db,
  config: Config,
  input: { name: string; description: string },
  budgetMs: number = config.storage.writeBudgetMs,
): Promise<Workflow> {
  const name = checkName(input.name);
  checkDescription(config, input.description);
  return stored.createWorkflow(db, { name, description: input.description }, budgetMs);
}

/** Renames a workflow or edits its description */
export async function updateWorkflow(
  db: Db,
  config: Config,
  id: string,
  changes: { name?: string; description?: string },
  budgetMs: number = config.storage.writeBudgetMs,
): Promise<Workflow> {
  const name = changes.name === undefined ? undefined : checkName(changes.name);
  if (changes.description !== undefined) checkDescription(config, changes.description);
  return stored.updateWorkflow(db, id, { name, description: changes.description }, budgetMs);
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new WorkflowError("A workflow needs a name.");
  return trimmed;
}

function checkDescription(config: Config, description: string): void {
  const limit = config.limits.workflowDescriptionTokens;
  const tokens = estimateTokens(description, config.estimation.charsPerToken);
  if (tokens > limit) {
    throw new WorkflowError(`The description is too long (about ${tokens} tokens; the limit is ${limit}).`);
  }
}