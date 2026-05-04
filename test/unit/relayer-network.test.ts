import { describe, expect, it } from "vitest";
import { parseEvmChainIdFromNetwork } from "../../src/config/relayerDiscovery.js";
import type { OzNetwork } from "../../src/relayer/client.js";

function net(partial: Pick<OzNetwork, "id"> & Partial<OzNetwork>): OzNetwork {
  return {
    network_type: "evm",
    required_confirmations: 1,
    ...partial,
  } as OzNetwork;
}

describe("parseEvmChainIdFromNetwork", () => {
  it("parses eip155 ids", () => {
    expect(parseEvmChainIdFromNetwork(net({ id: "eip155:8453" }))).toBe(8453);
  });

  it("parses evm numeric ids", () => {
    expect(parseEvmChainIdFromNetwork(net({ id: "evm:31337" }))).toBe(31337);
  });

  it("returns null when pattern is unknown", () => {
    expect(parseEvmChainIdFromNetwork(net({ id: "mainnet" }))).toBeNull();
  });

  it("prefers numeric chain_id from OZ when present", () => {
    expect(
      parseEvmChainIdFromNetwork(
        net({ id: "evm:mainnet", chain_id: 1, required_confirmations: 1 }),
      ),
    ).toBe(1);
  });

  it("prefers chain_id over a conflicting synthetic id", () => {
    expect(
      parseEvmChainIdFromNetwork(
        net({ id: "eip155:999", chain_id: 1, required_confirmations: 1 }),
      ),
    ).toBe(1);
  });
});
