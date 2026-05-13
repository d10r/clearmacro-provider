import { describe, expect, it, vi } from "vitest";
import { createReadyzReadinessCache } from "../../src/chain/readinessCache.js";

describe("createReadyzReadinessCache", () => {
  it("coalesces concurrent cache misses so inner runs once per chainId", async () => {
    let started = 0;
    const inner = vi.fn(async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { ready: true as const };
    });
    const cached = createReadyzReadinessCache(inner, { successTtlMs: 0, rateLimitedTtlMs: 0 });
    const [a, b] = await Promise.all([cached(7), cached(7)]);
    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(started).toBe(1);
  });

  it("calls inner once per chain within success TTL", async () => {
    const inner = vi.fn(async () => ({ ready: true as const }));
    const cached = createReadyzReadinessCache(inner, { successTtlMs: 60_000, rateLimitedTtlMs: 1000 });
    await cached(2);
    await cached(2);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not cache RELAYER_UNAVAILABLE so the next probe re-fetches", async () => {
    const inner = vi
      .fn()
      .mockResolvedValueOnce({ ready: false, reasonCode: "RELAYER_UNAVAILABLE" as const })
      .mockResolvedValueOnce({ ready: true as const });
    const cached = createReadyzReadinessCache(inner, { successTtlMs: 60_000, rateLimitedTtlMs: 1000 });
    const first = await cached(3);
    const second = await cached(3);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(first.ready).toBe(false);
    expect(second.ready).toBe(true);
  });

  it("caches RELAYER_RATE_LIMITED for the rate-limited TTL", async () => {
    vi.useFakeTimers();
    const inner = vi.fn(async () => ({ ready: false, reasonCode: "RELAYER_RATE_LIMITED" as const }));
    const cached = createReadyzReadinessCache(inner, { successTtlMs: 60_000, rateLimitedTtlMs: 5000 });
    await cached(4);
    await cached(4);
    expect(inner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5001);
    await cached(4);
    expect(inner).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
