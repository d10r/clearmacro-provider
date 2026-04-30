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

  it("returns relayer details on success envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              address: "0x00000000000000000000000000000000000000aa",
              paused: false,
              system_disabled: false,
              network: "mainnet",
              network_type: "evm",
            },
            error: null,
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new OzRelayerClient(baseUrl, "token", 200);
    const relayer = await client.getRelayer("r1");
    expect(relayer.address).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("returns network details on success envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              id: "evm:mainnet",
              network_type: "evm",
              required_confirmations: 1,
            },
            error: null,
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new OzRelayerClient(baseUrl, "token", 200);
    const network = await client.getNetwork("evm", "mainnet");
    expect(network.required_confirmations).toBe(1);
  });
});
