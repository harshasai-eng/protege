import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../config/settings.ts";
import { ProviderError } from "./types.ts";

/**
 * Runs attempt, retrying transient failures up to retry.maxRetries times. The wait
 * doubles from backoffMinMs up to backoffMaxMs, with jitter so many processes don't
 * retry in step, unless the server said how long to wait (Retry-After). The signal
 * cancels a wait at once. Other errors, and the last transient one, are thrown
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  retry: Config["retry"],
  signal?: AbortSignal,
): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== "transient" || tries >= retry.maxRetries) throw err;
      // Only a cancel ends the wait early; throw its reason, as the request does
      await sleep(retryDelay(err, tries, retry), undefined, { signal }).catch(() => signal?.throwIfAborted());
    }
  }
}

/** How long to wait before retry number tries + 1 */
export function retryDelay(err: ProviderError, tries: number, retry: Config["retry"]): number {
  if (err.retryAfterMs !== undefined) return err.retryAfterMs;
  const ceiling = Math.min(retry.backoffMaxMs, retry.backoffMinMs * 2 ** tries);
  return ceiling / 2 + Math.random() * (ceiling / 2); // between half and all of it
}