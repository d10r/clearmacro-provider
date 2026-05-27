import { afterEach, describe, expect, it, vi } from "vitest";
import { OzAdminClient } from "../../scripts/lib/oz-admin-client.js";

describe("OzAdminClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes network rpc_urls with bearer auth", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: "evm:localhost-anvil", rpc_urls: [{ url: "http://anvil:8545", weight: 100 }] },
          error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OzAdminClient("http://oz:8080", "test-api-key-32-characters-minimum", 5000);
    await client.updateNetworkRpcUrls("evm:localhost-anvil", [{ url: "http://anvil:8545", weight: 100 }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("http://oz:8080/api/v1/networks/evm%3Alocalhost-anvil");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key-32-characters-minimum");
    expect(JSON.parse(String(init.body))).toEqual({
      rpc_urls: [{ url: "http://anvil:8545", weight: 100 }],
    });
  });

  it("POSTs create relayer with expected body", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: "anvil-relayer", address: "0x1", paused: false, system_disabled: false },
          error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OzAdminClient("http://oz:8080", "test-api-key-32-characters-minimum", 5000);
    await client.createRelayer({
      id: "anvil-relayer",
      name: "Anvil",
      network: "localhost-anvil",
      network_type: "evm",
      signer_id: "prod-signer",
      policies: { min_balance: 0 },
    });

    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    const init = call![1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      id: "anvil-relayer",
      network: "localhost-anvil",
      signer_id: "prod-signer",
    });
  });
});
