import { describe, expect, it } from "vitest";
import { configSchema } from "../../config/settings.ts";
import { retryDelay, withRetries } from "../retry.ts";
import { ProviderError } from "../types.ts";

const retry = configSchema.parse({ model: { name: "m" } }).retry; // 2 retries, 1 s to 30 s
const fast = { ...retry, backoffMinMs: 1, backoffMaxMs: 2 };
const transient = (retryAfterMs?: number) => new ProviderError("transient", "busy", retryAfterMs);

describe("withRetries", () => {
  it("retries transient failures, up to maxRetries", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw transient();
    };
    await expect(withRetries(attempt, fast)).rejects.toMatchObject({ kind: "transient" });
    expect(calls).toBe(3);
  });

  it("throws anything else at once", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new ProviderError("permanent", "bad key");
    };
    await expect(withRetries(attempt, fast)).rejects.toMatchObject({ kind: "permanent" });
    expect(calls).toBe(1);
  });

  it("stops waiting at once when cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = withRetries(async () => { throw transient(60_000); }, retry, controller.signal);
    setTimeout(() => controller.abort(new Error("stopped")), 20);
    await expect(waiting).rejects.toThrow("stopped");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("retryDelay", () => {
  it("doubles from the minimum up to the maximum, with jitter", () => {
    for (const [tries, ceiling] of [[0, 1_000], [1, 2_000], [5, 30_000], [10, 30_000]] as const) {
      const ms = retryDelay(transient(), tries, retry);
      expect(ms).toBeGreaterThanOrEqual(ceiling / 2);
      expect(ms).toBeLessThanOrEqual(ceiling);
    }
  });

  it("waits as long as the server said, when it said", () => {
    expect(retryDelay(transient(7_000), 0, retry)).toBe(7_000);
  });
});