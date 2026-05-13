import { describe, expect, it } from "vitest";
import { withOzRateLimitRetries } from "../../src/chain/readiness.js";
import { OzRelayerRateLimitError } from "../../src/relayer/errors.js";

describe("withOzRateLimitRetries", () => {
  it("retries on OzRelayerRateLimitError then returns the resolved value", async () => {
    let n = 0;
    const result = await withOzRateLimitRetries(
      async () => {
        n += 1;
        if (n < 3) {
          throw new OzRelayerRateLimitError("limit", 429, "/api/v1/ready", 1);
        }
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(n).toBe(3);
  });

  it("stops after maxAttempts and propagates OzRelayerRateLimitError", async () => {
    let n = 0;
    await expect(
      withOzRateLimitRetries(
        async () => {
          n += 1;
          throw new OzRelayerRateLimitError("limit", 429, "/", 1);
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(OzRelayerRateLimitError);
    expect(n).toBe(2);
  });
});
