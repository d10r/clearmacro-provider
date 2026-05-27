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

  it("lists relayer ids from a single-page items response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/relayers?page=1")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: { items: [{ id: "rel-a" }, { id: "rel-b" }] },
              error: null,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ success: false, data: null, error: "unexpected" }), { status: 200 });
      }),
    );
    const client = new OzRelayerClient(baseUrl, "token", 200);
    const ids = await client.listRelayerIds();
    expect(ids).toEqual(["rel-a", "rel-b"]);
  });

  it("continues paginating when OpenZeppelin caps page size at 10", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/relayers?page=1")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: Array.from({ length: 10 }, (_, i) => ({ id: `rel-${i}` })),
              error: null,
            }),
            { status: 200 },
          );
        }
        if (u.includes("/relayers?page=2")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: [{ id: "rel-10" }, { id: "rel-11" }],
              error: null,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ success: true, data: [], error: null }), { status: 200 });
      }),
    );
    const client = new OzRelayerClient(baseUrl, "token", 200);
    const ids = await client.listRelayerIds();
    expect(ids).toEqual([...Array.from({ length: 10 }, (_, i) => `rel-${i}`), "rel-10", "rel-11"]);
  });

  it("lists relayer ids from a top-level array response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [{ id: "x1" }],
            error: null,
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new OzRelayerClient(baseUrl, "token", 200);
    const ids = await client.listRelayerIds();
    expect(ids).toEqual(["x1"]);
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
              chain_id: 42161,
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
    expect(network.chain_id).toBe(42161);
  });
});
