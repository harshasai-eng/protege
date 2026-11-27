import { type ModelProvider, type ModelRequest, type ModelResponse, ProviderError } from "./types.ts";

// A stand-in provider for tests: plays back a script of responses and failures,
// in order, and keeps every request it was sent. It stands for the provider after
// its retries, so a ProviderError here is a final one

export type ScriptStep = ModelResponse | ProviderError | ((request: ModelRequest) => ModelResponse | ProviderError);

export class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly #script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.#script = [...script];
  }

  async send(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    signal?.throwIfAborted();
    this.requests.push(request);
    const step = this.#script.shift();
    if (step === undefined) throw new Error(`The script has no response for request ${this.requests.length}`);
    const result = typeof step === "function" ? step(request) : step;
    if (result instanceof ProviderError) throw result;
    return result;
  }

  /** Steps not yet used: a test can check the script was played to the end */
  get remaining(): number {
    return this.#script.length;
  }
}

/** A complete response with these output items, for scripts */
export function scriptedResponse(output: unknown[], stopped: ModelResponse["stopped"] = "complete"): ModelResponse {
  return { id: `resp_${Math.random().toString(36).slice(2)}`, output, usage: { input_tokens: 0, output_tokens: 0 }, stopped };
}