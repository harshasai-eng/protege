// Three checks against the real API, run by hand (never in CI: it costs money and
// needs a key): `node provider/check-live.ts`. Uses your protege.yaml and API key.
// Each checks a setting the design depends on that only the live API can confirm

import { randomUUID } from "node:crypto";
import { loadApiKey, loadConfig } from "../config/load.ts";
import { OpenAIProvider } from "./openai.ts";
import type { ModelRequest } from "./types.ts";

const config = await loadConfig();
const provider = new OpenAIProvider({ apiKey: await loadApiKey(), baseUrl: config.provider.baseUrl, retry: config.retry, cacheTtl: config.cache.ttl });

const base = (input: unknown[], tools: unknown[] = []): ModelRequest => ({
  model: config.model.name,
  instructions: "You are a test assistant. Answer in one short sentence.",
  tools,
  input,
  maxOutputTokens: 4_000,
  reasoningEffort: "low",
  cacheKey: randomUUID(), // a fresh cache for each run of this script
});
const user = (text: string) => ({ type: "message", role: "user", content: text });
const types = (output: unknown[]) => output.map((i) => (i as { type: string }).type);

async function check(name: string, fn: () => Promise<string>) {
  try {
    console.log(`PASS  ${name}: ${await fn()}`);
  } catch (err) {
    console.log(`FAIL  ${name}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// 1. The same long prefix twice with the same cache key: the second call reads it
//    from the cache (caching needs a prefix of at least 1,024 tokens)
await check("prompt cache", async () => {
  const long = user(`Background, ignore it:\n${"The receipts are filed by month and by vendor. ".repeat(300)}`);
  const request = base([long, user("Say OK.")]);
  await provider.send(request);
  const second = await provider.send(request);
  const cached = (second.usage.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0;
  if (cached === 0) throw new Error("the second call read nothing from the cache");
  return `${cached} of ${second.usage.input_tokens} input tokens cached`;
});

// 2. With store: false, reasoning comes back encrypted, and sending it back works
await check("encrypted reasoning round trip", async () => {
  const first = await provider.send({ ...base([user("What is 17 * 23? Think it through.")]), reasoningEffort: "medium" });
  const reasoning = first.output.find((i) => (i as { type: string }).type === "reasoning") as { encrypted_content?: string } | undefined;
  if (!reasoning?.encrypted_content) throw new Error(`no encrypted reasoning in: ${types(first.output).join(", ")}`);
  const second = await provider.send(base([user("What is 17 * 23? Think it through."), ...first.output, user("Now add 9.")]));
  return `sent back ${types(first.output).join(", ")}; next response ${second.stopped}`;
});

// 3. With store: false, web search results can be sent back as history
await check("web_search_call items sent back", async () => {
  const tools = [{ type: "web_search" }];
  const question = user("Search the web: what is the latest stable version of Node.js?");
  const first = await provider.send(base([question], tools));
  if (!types(first.output).includes("web_search_call")) throw new Error(`no web_search_call in: ${types(first.output).join(", ")}`);
  const second = await provider.send(base([question, ...first.output, user("And when was it released?")], tools));
  return `sent back ${types(first.output).join(", ")}; next response ${second.stopped}`;
});