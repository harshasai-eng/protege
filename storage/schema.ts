import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Database tables. Column names are camelCase here and snake_case in SQLite
// (casing: "snake_case" in db.ts and drizzle.config.ts)
// IDs: UUIDv7 text. Times: epoch milliseconds. JSON: text checked by json_valid

const id = () => text();
const time = () => integer();
const json = <T>() => text({ mode: "json" }).$type<T>();

// ---- Workflows and skills

export const workflows = sqliteTable(
  "workflows",
  {
    id: id().primaryKey(),
    name: text().notNull(),
    description: text().notNull(),
    createdAt: time().notNull(),
    updatedAt: time().notNull(),
  },
  (t) => [uniqueIndex("workflows_name").on(sql`lower(${t.name})`)],
);

export const skills = sqliteTable(
  "skills",
  {
    id: id().primaryKey(),
    workflowId: id()
      .notNull()
      .references(() => workflows.id),
    name: text().notNull(),
    // Empty: retired (or not yet given its first version)
    activeVersionId: id().references((): AnySQLiteColumn => skillVersions.id),
    createdAt: time().notNull(),
  },
  (t) => [uniqueIndex("skills_workflow_name").on(t.workflowId, t.name)],
);

export const skillVersions = sqliteTable(
  "skill_versions",
  {
    id: id().primaryKey(),
    skillId: id()
      .notNull()
      .references(() => skills.id),
    version: integer().notNull(),
    createdAt: time().notNull(),
    activatedAt: time(), // set by the import's last write; empty = a leftover
  },
  (t) => [uniqueIndex("skill_versions_skill_version").on(t.skillId, t.version)],
);

export const skillVersionFiles = sqliteTable(
  "skill_version_files",
  {
    skillVersionId: id()
      .notNull()
      .references(() => skillVersions.id),
    path: text().notNull(), // relative, forward slashes
    content: blob({ mode: "buffer" }).notNull(),
    sha256: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillVersionId, t.path] })],
);

// ---- Sessions, runs and items

export const sessions = sqliteTable(
  "sessions",
  {
    id: id().primaryKey(),
    workflowId: id()
      .notNull()
      .references(() => workflows.id),
    kind: text({ enum: ["interactive", "worker", "subagent"] }).notNull(),
    parentSessionId: id().references((): AnySQLiteColumn => sessions.id),
    parentCallId: text(),
    cwd: text().notNull(),
    startedAt: time().notNull(),
    lastActivityAt: time().notNull(),
    closedAt: time(),
    closeReason: text({
      enum: ["marked", "worker_finished", "subagent_finished", "interrupted"],
    }),
    outcome: text({ enum: ["successful", "failed"] }),
    outcomeNote: text(),
    outcomeAt: time(),
  },
  (t) => [
    check("sessions_kind", sql`${t.kind} in ('interactive', 'worker', 'subagent')`),
    check(
      "sessions_close_reason",
      sql`${t.closeReason} in ('marked', 'worker_finished', 'subagent_finished', 'interrupted')`,
    ),
    check("sessions_outcome", sql`${t.outcome} in ('successful', 'failed')`),
    // Columns that are set together
    check("sessions_closed", sql`(${t.closedAt} is null) = (${t.closeReason} is null)`),
    check("sessions_parent", sql`(${t.kind} = 'subagent') = (${t.parentSessionId} is not null)`),
    check("sessions_parent_call", sql`(${t.parentSessionId} is null) = (${t.parentCallId} is null)`),
    check("sessions_outcome_at", sql`(${t.outcome} is null) = (${t.outcomeAt} is null)`),
    check(
      "sessions_marked",
      sql`${t.outcome} is null or (${t.kind} = 'interactive' and ${t.closeReason} = 'marked')`,
    ),
    // Listings and --continue; the picker's "last used"; children; cleanup and retention
    index("sessions_cwd").on(t.cwd, t.lastActivityAt).where(sql`${t.kind} <> 'subagent'`),
    index("sessions_workflow").on(t.workflowId, t.lastActivityAt).where(sql`${t.kind} = 'interactive'`),
    index("sessions_parent").on(t.parentSessionId).where(sql`${t.parentSessionId} is not null`),
    index("sessions_open").on(t.lastActivityAt).where(sql`${t.closedAt} is null`),
  ],
);

export const sessionSkills = sqliteTable(
  "session_skills",
  {
    sessionId: id()
      .notNull()
      .references(() => sessions.id),
    skillId: id()
      .notNull()
      .references(() => skills.id),
    skillVersionId: id()
      .notNull()
      .references(() => skillVersions.id),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.skillId] })],
);

const END_REASONS = [
  "completed",
  "max_turns",
  "cancelled",
  "time_limit",
  "interrupted",
  "output_truncated",
  "content_filtered",
  "transient_exhausted",
  "non_retryable",
  "context_overflow",
] as const;

export const runs = sqliteTable(
  "runs",
  {
    sessionId: id()
      .notNull()
      .references(() => sessions.id),
    runIndex: integer().notNull(),
    startedAt: time().notNull(),
    endedAt: time(),
    endReason: text({ enum: END_REASONS }),
    turnCount: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.runIndex] }),
    check(
      "runs_end_reason",
      sql.raw(`end_reason in (${END_REASONS.map((r) => `'${r}'`).join(", ")})`),
    ),
    check("runs_ended", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    // One run at a time per session
    uniqueIndex("runs_active").on(t.sessionId).where(sql`${t.endedAt} is null`),
  ],
);

export const items = sqliteTable(
  "items",
  {
    sessionId: id()
      .notNull()
      .references(() => sessions.id),
    seq: integer().notNull(),
    runIndex: integer(),
    turnIndex: integer(),
    callId: text(),
    createdAt: time().notNull(),
    itemType: text().notNull(), // Protege's types, or the provider's own for unknown items
    itemJson: json<unknown>().notNull(),
    meta: json<Record<string, unknown>>(),
    providerResponseId: text(),
    usage: json<Record<string, unknown>>(),
    callSettings: json<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    foreignKey({ columns: [t.sessionId, t.runIndex], foreignColumns: [runs.sessionId, runs.runIndex] }),
    check(
      "items_call_id",
      sql`(${t.callId} is not null) = (${t.itemType} in ('function_call', 'function_call_output'))`,
    ),
    check("items_usage", sql`(${t.providerResponseId} is null) = (${t.usage} is null)`),
    check("items_json", sql`json_valid(${t.itemJson})`),
    check("items_meta", sql`${t.meta} is null or json_valid(${t.meta})`),
    // Latest setup, compaction, mode note, update_tasks; call/output joins; clearing and estimates
    index("items_type").on(t.sessionId, t.itemType, t.seq),
    index("items_call").on(t.sessionId, t.callId).where(sql`${t.callId} is not null`),
    index("items_response").on(t.sessionId, t.seq).where(sql`${t.providerResponseId} is not null`),
  ],
);