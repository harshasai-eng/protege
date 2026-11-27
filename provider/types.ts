// What the engine sends and gets back

export interface ModelRequest {
  model: string;
  instructions: string;
  tools: unknown[]; // tool definitions
  input: unknown[]; // the projection's items
  maxOutputTokens: number;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  cacheKey: string; // session id: requests that share it share a cache
  toolChoice?: "auto" | "none"; // "none": wrap-up turn and compaction
}

export interface ModelResponse {
  id: string;
  output: unknown[]; // the response's items
  usage: Record<string, unknown>;
  // complete: finished normally. cut_off: hit max_output_tokens.
  // filtered: the provider's content filter stopped it
  stopped: "complete" | "cut_off" | "filtered";
}

/**
 * Failed request handling:
 * transient: still failing after the retries (rate limits, server errors, timeouts, dropped connections)
 * permanent: no retry (bad key, unknown model, bad request)
 * too_large: exceeded context window
 */
export class ProviderError extends Error {
  override name = "ProviderError";
  readonly kind: "transient" | "permanent" | "too_large";
  readonly retryAfterMs: number | undefined; // the server said how long to wait

  constructor(
    kind: ProviderError["kind"],
    message: string,
    retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Sends one request; retries transient failures itself. Cancelled by the signal */
export interface ModelProvider {
  send(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}