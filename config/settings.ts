import { z } from "zod";

// Schema for protege.yaml. Everything but model.name has a default.
// strictObject: unknown keys (typos) are errors
// prefault({}): a missing section gets its defaults

const count = z.number().int().positive();
const fraction = z.number().gt(0).lt(1);

export const configSchema = z
  .strictObject({
    provider: z.strictObject({ baseUrl: z.url().default("https://api.openai.com/v1") }).prefault({}),
    model: z.strictObject({
      name: z.string().min(1),
      contextWindow: count.default(200_000),
      maxOutputTokens: count.default(25_000), // reasoning included; a cut-off response ends the run
      reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).default("medium"),
    }),
    loop: z.strictObject({ maxTurns: count.default(25) }).prefault({}),
    retry: z
      .strictObject({
        maxRetries: z.number().int().min(0).default(2), // 3 attempts
        backoffMinMs: count.default(1_000),
        backoffMaxMs: count.default(30_000),
        requestTimeoutMs: count.default(600_000),
      })
      .prefault({}),
    compaction: z
      .strictObject({
        threshold: fraction.default(0.8), // of contextWindow minus maxOutputTokens
        summaryMaxTokens: count.default(25_000), // the summary call's output, reasoning included
      })
      .prefault({}),
    limits: z
      .strictObject({
        workflowDescriptionTokens: count.default(500),
        toolOutputTokens: count.default(10_000),
        turnToolOutputTokens: count.default(50_000),
        previewTokens: count.default(500),
        userMessageChars: count.default(100_000),
      })
      .prefault({}),
    estimation: z.strictObject({ charsPerToken: z.number().positive().default(4) }).prefault({}),
    cache: z.strictObject({ ttl: z.enum(["30m", "12h"]).default("30m") }).prefault({}),
    tools: z
      .strictObject({
        maxConcurrent: count.default(10),
        webSearch: z.boolean().default(true),
        readFile: z
          .strictObject({ defaultLimitLines: count.default(800), maxLineChars: count.default(2_000) })
          .prefault({}),
        findFiles: z.strictObject({ maxResults: count.default(200) }).prefault({}),
        searchText: z
          .strictObject({
            maxMatches: count.default(100),
            maxLineChars: count.default(500),
            maxContext: z.number().int().min(0).default(5),
          })
          .prefault({}),
      })
      .prefault({}),
    shell: z
      .strictObject({
        defaultTimeoutMs: count.default(120_000),
        maxTimeoutMs: count.default(600_000),
      })
      .prefault({}),
    permissions: z
      .strictObject({ defaultMode: z.enum(["plan", "ask", "auto"]).default("ask") })
      .prefault({}),
    worker: z.strictObject({ timeoutMinutes: count.default(60) }).prefault({}),
    storage: z
      .strictObject({
        busyTimeoutMs: count.default(100), // SQLite's own wait; it freezes the process
        runWriteBudgetMs: count.default(60_000), // retries, writes during a run
        writeBudgetMs: count.default(20_000), // retries, other writes
        cleanupBudgetMs: count.default(1_000), // retries, startup cleanup
        artifactRetentionDays: count.default(30),
      })
      .prefault({}),
    skills: z
      .strictObject({
        maxPerWorkflow: count.default(5),
        skillMdTokens: count.default(5_000),
      })
      .prefault({}),
  })
  // Settings that must agree
  .superRefine((c, ctx) => {
    const problem = (path: string[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (c.model.maxOutputTokens >= c.model.contextWindow)
      problem(["model", "maxOutputTokens"], "must be below model.contextWindow");
    if (c.compaction.summaryMaxTokens >= c.model.contextWindow)
      problem(["compaction", "summaryMaxTokens"], "must be below model.contextWindow");
    if (c.shell.defaultTimeoutMs > c.shell.maxTimeoutMs)
      problem(["shell", "defaultTimeoutMs"], "must not exceed shell.maxTimeoutMs");
    if (c.retry.backoffMinMs > c.retry.backoffMaxMs)
      problem(["retry", "backoffMinMs"], "must not exceed retry.backoffMaxMs");
  });

/** Read once when a session opens or resumes */
export type Config = z.infer<typeof configSchema>;