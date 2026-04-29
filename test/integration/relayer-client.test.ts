import { afterEach, describe, expect, it, vi } from "vitest";
import { OzRelayerClient } from "../../src/relayer/client.js";

const baseUrl = "http://relayer.test";
const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

describe("oz relayer client", () => {
  it("throws on non-2xx submit response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "busy" }), { status: 503 })),
    );
    const client = new OzRelayerClient(baseUrl, "token", 200);
    await expect(
      client.submitTransaction("r1", { to: "0x1", value: "0", data: "0x", speed: "fast" }),
    ).rejects.toThrow(/Relayer HTTP 503/);
  });

  it("throws on malformed success envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, data: null, error: null }), { status: 200 })),
    );
    const client = new OzRelayerClient(baseUrl, "token", 200);
    await expect(client.getTransaction("r1", "tx-1")).rejects.toThrow(/lookup failed/);
  });
});
