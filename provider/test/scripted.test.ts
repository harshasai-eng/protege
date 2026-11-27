import { describe, expect, it } from "vitest";
import { ScriptedProvider, scriptedResponse } from "../scripted.ts";
import { type ModelRequest, ProviderError } from "../types.ts";

const request = (text: string): ModelRequest => ({
  model: "m",
  instructions: "i",
  tools: [],
  input: [{ type: "message", role: "user", content: text }],
  maxOutputTokens: 100,
  reasoningEffort: "low",
  cacheKey: "s",
});

describe("ScriptedProvider", () => {
  it("plays its script in order and keeps the requests", async () => {
    const first = scriptedResponse([{ type: "message", content: "one" }]);
    const provider = new ScriptedProvider([
      first,
      new ProviderError("transient", "busy"),
      (req) => scriptedResponse([{ type: "message", content: `echo ${req.input.length}` }]),
    ]);
    expect(await provider.send(request("a"))).toBe(first);
    await expect(provider.send(request("b"))).rejects.toMatchObject({ kind: "transient" });
    expect((await provider.send(request("c"))).output).toEqual([{ type: "message", content: "echo 1" }]);
    expect(provider.requests.map((r) => r.input)).toEqual([request("a").input, request("b").input, request("c").input]);
    expect(provider.remaining).toBe(0);
  });

  it("fails loudly when the script runs out", async () => {
    await expect(new ScriptedProvider([]).send(request("a"))).rejects.toThrow(/no response for request 1/);
  });

  it("refuses when already cancelled", async () => {
    const provider = new ScriptedProvider([scriptedResponse([])]);
    await expect(provider.send(request("a"), AbortSignal.abort())).rejects.toThrow();
    expect(provider.remaining).toBe(1);
  });
});