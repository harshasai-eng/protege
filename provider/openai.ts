import OpenAI, { APIConnectionError, APIError } from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { Config } from "../config/settings.ts";
import { withRetries } from "./retry.ts";
import { type ModelProvider, type ModelRequest, type ModelResponse, ProviderError } from "./types.ts";

// The real provider: OpenAI's Responses API, through the openai package.
// Only provider/ imports openai (test/architecture.test.ts checks it)

export interface OpenAIOptions {
  apiKey: string;
  baseUrl: string;
  retry: Config["retry"];
  cacheTtl: Config["cache"]["ttl"];
}

export class OpenAIProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #retry: Config["retry"];
  readonly #cacheTtl: Config["cache"]["ttl"];

  constructor(options: OpenAIOptions) {
    // The package's own retries are off: ours (retry.ts) are the only ones
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: 0,
      timeout: options.retry.requestTimeoutMs,
    });
    this.#retry = options.retry;
    this.#cacheTtl = options.cacheTtl;
  }

  send(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    return withRetries(() => this.#attempt(request, signal), this.#retry, signal);
  }

  async #attempt(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await this.#client.responses.create(toParams(request, this.#cacheTtl), { signal });
    } catch (err) {
      if (signal?.aborted) throw signal.reason; // cancelled: not a provider failure
      throw toProviderError(err);
    }
    return fromResponse(response);
  }
}

/** The request as the API takes it: the settings the spec fixes, plus the engine's */
export function toParams(request: ModelRequest, cacheTtl: Config["cache"]["ttl"]): ResponseCreateParamsNonStreaming {
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input as ResponseCreateParamsNonStreaming["input"],
    tools: request.tools as ResponseCreateParamsNonStreaming["tools"],
    tool_choice: request.toolChoice ?? "auto",
    max_output_tokens: request.maxOutputTokens,
    reasoning: { effort: request.reasoningEffort, summary: "auto" },
    store: false, // nothing kept on OpenAI's side; the history is ours
    include: ["reasoning.encrypted_content"], // so reasoning can be sent back
    prompt_cache_key: request.cacheKey,
    prompt_cache_options: { ttl: cacheTtl },
    stream: false,
  };
}

function fromResponse(response: Response): ModelResponse {
  const base = { id: response.id, output: response.output, usage: { ...(response.usage ?? {}) } };
  if (response.status === "completed") return { ...base, stopped: "complete" };
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return { ...base, stopped: "cut_off" };
    if (reason === "content_filter") return { ...base, stopped: "filtered" };
  }
  if (response.status === "failed") {
    const code = response.error?.code;
    const kind = code === "server_error" || code === "rate_limit_exceeded" ? "transient" : "permanent";
    throw new ProviderError(kind, `The model provider failed: ${response.error?.message ?? code ?? "no reason given"}`);
  }
  throw new ProviderError("permanent", `The model provider returned an unexpected status: ${response.status}`);
}

/** Sorts a failed request into transient, permanent or too_large */
export function toProviderError(err: unknown): ProviderError {
  // No answer at all: a dropped connection or a timeout
  if (err instanceof APIConnectionError) return new ProviderError("transient", err.message, undefined, { cause: err });
  if (!(err instanceof APIError)) throw err; // not from the API: a bug, so not hidden
  const status = err.status ?? 0;
  const code = err.code ?? "";
  if (code === "context_length_exceeded" || /context (length|window)/i.test(err.message)) {
    return new ProviderError("too_large", err.message, undefined, { cause: err });
  }
  // 429 also means "out of credits", which retrying won't fix
  if (code === "insufficient_quota") return new ProviderError("permanent", err.message, undefined, { cause: err });
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return new ProviderError("transient", err.message, retryAfter(err.headers), { cause: err });
  }
  return new ProviderError("permanent", err.message, undefined, { cause: err });
}

// Retry-After: seconds, or an HTTP date; retry-after-ms is OpenAI's own, in ms
function retryAfter(headers: Headers | undefined): number | undefined {
  const ms = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}