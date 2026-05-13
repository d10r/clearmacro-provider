import { afterEach, describe, expect, it, vi } from "vitest";
import { OzRelayerClient } from "../../src/relayer/client.js";
import { OzRelayerHttpError, OzRelayerRateLimitError } from "../../src/relayer/errors.js";

describe("OzRelayerClient HTTP errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws OzRelayerRateLimitError on HTTP 429 with OZ JSON after in seconds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: false,
            code: 429,
            error: "TooManyRequests",
            message: "Too Many Requests",
            after: 2,
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const client = new OzRelayerClient("http://oz.test", "key", 5000);
    try {
      await client.ready();
      expect.fail("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(OzRelayerRateLimitError);
      expect((e as OzRelayerRateLimitError).retryAfterMs).toBe(2000);
    }
  });

  it("prefers Retry-After header over JSON after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, code: 429, after: 60 }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "1",
          },
        }),
      ),
    );
    const client = new OzRelayerClient("http://oz.test", "key", 5000);
    try {
      await client.ready();
      expect.fail("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(OzRelayerRateLimitError);
      expect((e as OzRelayerRateLimitError).retryAfterMs).toBe(1000);
    }
  });

  it("throws OzRelayerHttpError on other non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502, headers: { "content-type": "text/plain" } })),
    );
    const client = new OzRelayerClient("http://oz.test", "key", 5000);
    try {
      await client.ready();
      expect.fail("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(OzRelayerHttpError);
      expect((e as OzRelayerHttpError).status).toBe(502);
    }
  });
});
