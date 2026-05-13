import type { ChainReadinessResult } from "./readiness.js";

/**
 * TTL cache plus **single-flight** coalescing for `GET /readyz` only.
 * Concurrent probes for the same `chainId` while the cache is cold or expired share one `inner()` call.
 * Mutation paths should call the uncached readiness evaluator.
 */
export function createReadyzReadinessCache(
  inner: (chainId: number) => Promise<ChainReadinessResult>,
  options: { successTtlMs: number; rateLimitedTtlMs: number },
): (chainId: number) => Promise<ChainReadinessResult> {
  const cache = new Map<number, { expiresAt: number; result: ChainReadinessResult }>();
  const inflight = new Map<number, Promise<ChainReadinessResult>>();

  return (chainId: number): Promise<ChainReadinessResult> => {
    const now = Date.now();
    const hit = cache.get(chainId);
    if (hit && hit.expiresAt > now) {
      return Promise.resolve(hit.result);
    }

    const existing = inflight.get(chainId);
    if (existing) {
      return existing;
    }

    let resolve!: (value: ChainReadinessResult) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<ChainReadinessResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    inflight.set(chainId, promise);

    inner(chainId)
      .then((result) => {
        const ts = Date.now();
        let ttl = 0;
        if (result.ready && options.successTtlMs > 0) {
          ttl = options.successTtlMs;
        } else if (result.reasonCode === "RELAYER_RATE_LIMITED" && options.rateLimitedTtlMs > 0) {
          ttl = options.rateLimitedTtlMs;
        }
        if (ttl > 0) {
          cache.set(chainId, { expiresAt: ts + ttl, result });
        }
        // Clear before resolve: await continuations run as microtasks and may call
        // cached() again before a .finally() callback runs, which would incorrectly
        // treat the next probe as still in-flight.
        inflight.delete(chainId);
        resolve(result);
      })
      .catch((err) => {
        inflight.delete(chainId);
        reject(err);
      });

    return promise;
  };
}
