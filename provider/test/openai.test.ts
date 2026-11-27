import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../../config/settings.ts";
import { OpenAIProvider } from "../openai.ts";
import { type ModelRequest, ProviderError } from "../types.ts";

// The real client against a local HTTP server that plays OpenAI: real requests,
// real error parsing, no network

const retry = configSchema.parse({ model: { name: "m" }, retry: { backoffMinMs: 1, backoffMaxMs: 2 } }).retry;

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "hang";

let server: Server;
let replies: Reply[];
let bodies: Record<string, unknown>[];
let provider: OpenAIProvider;

beforeEach(async () => {
  replies = [];
  bodies = [];
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    bodies.push(JSON.parse(text));
    const reply = replies.shift() ?? { status: 500, body: { error: { message: "no reply scripted" } } };
    if (reply === "hang") return; // never answers: the client has to give up
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
    provider = new OpenAIProvider({ apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/v1`, retry, cacheTtl: "30m" });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const request: ModelRequest = {
  model: "test-model",
  instructions: "You are Protege.",
  tools: [],
  input: [{ type: "message", role: "user", content: "hi" }],
  maxOutputTokens: 25_000,
  reasoningEffort: "medium",
  cacheKey: "session-1",
};

const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] };

function response(fields: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: { id: "resp_1", object: "response", status: "completed", output: [message], usage: { input_tokens: 10, output_tokens: 2 }, error: null, incomplete_details: null, ...fields },
  };
}
const apiError = (status: number, code: string | null, message = "failed", headers?: Record<string, string>): Reply => ({
  status,
  body: { error: { message, type: "error", code } },
  headers,
});

describe("OpenAIProvider", () => {
  it("sends the fixed settings with the engine's, and returns the items as sent", async () => {
    replies.push(response());
    const result = await provider.send({ ...request, toolChoice: "none" });
    expect(bodies[0]).toMatchObject({
      model: "test-model",
      instructions: "You are Protege.",
      input: request.input,
      tool_choice: "none",
      max_output_tokens: 25_000,
      reasoning: { effort: "medium", summary: "auto" },
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-1",
      prompt_cache_options: { ttl: "30m" },
    });
    expect(result).toEqual({ id: "resp_1", output: [message], usage: { input_tokens: 10, output_tokens: 2 }, stopped: "complete" });
  });

  it("says how a response stopped short: cut off, or filtered", async () => {
    replies.push(response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    replies.push(response({ status: "incomplete", incomplete_details: { reason: "content_filter" } }));
    expect((await provider.send(request)).stopped).toBe("cut_off");
    expect((await provider.send(request)).stopped).toBe("filtered");
  });

  it("retries server errors and rate limits, then succeeds", async () => {
    replies.push(apiError(500, null), apiError(429, "rate_limit_exceeded"), response());
    expect((await provider.send(request)).id).toBe("resp_1");
    expect(bodies).toHaveLength(3);
  });

  it("gives up after the retries, as transient", async () => {
    replies.push(apiError(503, null), apiError(503, null), apiError(503, "server_overloaded", "busy"));
    await expect(provider.send(request)).rejects.toMatchObject({ name: "ProviderError", kind: "transient" });
    expect(bodies).toHaveLength(3); // 1 + maxRetries
  });

  it("doesn't retry what retrying won't fix", async () => {
    replies.push(apiError(401, "invalid_api_key"));
    await expect(provider.send(request)).rejects.toMatchObject({ kind: "permanent" });
    replies.push(apiError(429, "insufficient_quota", "out of credits"));
    await expect(provider.send(request)).rejects.toMatchObject({ kind: "permanent" });
    expect(bodies).toHaveLength(2);
  });

  it("names a request over the context window too_large", async () => {
    replies.push(apiError(400, "context_length_exceeded", "Your input exceeds the context window of this model."));
    await expect(provider.send(request)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("maps a response that failed by its error code", async () => {
    replies.push(response({ status: "failed", error: { code: "server_error", message: "oops" } }), response());
    expect((await provider.send(request)).stopped).toBe("complete"); // server_error: retried
    replies.push(response({ status: "failed", error: { code: "invalid_prompt", message: "bad prompt" } }));
    await expect(provider.send(request)).rejects.toMatchObject({ kind: "permanent" });
  });

  it("stops at once when cancelled, with the cancel's reason, not a provider error", async () => {
    replies.push("hang");
    const controller = new AbortController();
    const sent = provider.send(request, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("stopped"));
    await expect(sent).rejects.toThrow("stopped");
    await expect(sent).rejects.not.toBeInstanceOf(ProviderError);
  });

  it("treats a timeout as transient", async () => {
    const quick = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      retry: { ...retry, maxRetries: 0, requestTimeoutMs: 100 },
      cacheTtl: "30m",
    });
    replies.push("hang");
    await expect(quick.send(request)).rejects.toMatchObject({ kind: "transient" });
  });
});