import { z } from "zod";

// Schema for protege.yaml. Everything but model.name has a default.
// strictObject: unknown keys (typos) are errors
// prefault({}): a missing section gets its defaults

const count = z.number().int().positive();
const fraction = z.number().gt(0).lt(1);

export const configSchema = z
  .strictObject({
    provider: z
      .strictObject({
        baseUrl: z.url().default("https://api.openai.com/v1"),
        apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
      })
      .prefault({}),
    model: z.strictObject({
      name: z.string().min(1),
      contextWindow: count.default(200_000),
      maxOutputTokens: count.default(8_000),
      retryMaxOutputTokens: count.default(32_000),
      reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).default("medium"),
    }),
    loop: z.strictObject({ maxTurns: count.default(25) }).prefault({}),
    retry: z
      .strictObject({
        maxRetries: z.number().int().min(0).default(3),
        backoffMinMs: count.default(1_000),
        backoffMaxMs: count.default(30_000),
        requestTimeoutMs: count.default(600_000),
      })
      .prefault({}),
    compaction: z
      .strictObject({
        threshold: fraction.default(0.75),
        reactiveTarget: fraction.default(0.6),
        summaryMaxTokens: count.default(20_000),
        maxFailures: count.default(3),
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
    clearing: z.strictObject({ keepRecent: z.number().int().min(0).default(5) }).prefault({}),
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
    vision: z.strictObject({ model: z.string().min(1).nullable().default(null) }).prefault({}),
    shell: z
      .strictObject({
        defaultTimeoutMs: count.default(120_000),
        maxTimeoutMs: count.default(600_000),
        stopGraceMs: count.default(5_000),
      })
      .prefault({}),
    permissions: z
      .strictObject({ defaultMode: z.enum(["plan", "ask", "auto"]).default("ask") })
      .prefault({}),
    worker: z.strictObject({ timeoutMinutes: count.default(60) }).prefault({}),
    storage: z
      .strictObject({
        busyTimeoutMs: count.default(100),
        runWriteBudgetMs: count.default(60_000),
        writeBudgetMs: count.default(20_000),
        cleanupBudgetMs: count.default(1_000),
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
    if (c.model.retryMaxOutputTokens < c.model.maxOutputTokens)
      problem(["model", "retryMaxOutputTokens"], "must be at least model.maxOutputTokens");
    if (c.compaction.reactiveTarget >= c.compaction.threshold)
      problem(["compaction", "reactiveTarget"], "must be below compaction.threshold");
    if (c.shell.defaultTimeoutMs > c.shell.maxTimeoutMs)
      problem(["shell", "defaultTimeoutMs"], "must not exceed shell.maxTimeoutMs");
    if (c.retry.backoffMinMs > c.retry.backoffMaxMs)
      problem(["retry", "backoffMinMs"], "must not exceed retry.backoffMaxMs");
  });

/** Read once when a session opens or resumes */
export type Config = z.infer<typeof configSchema>;