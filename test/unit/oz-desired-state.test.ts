import { describe, expect, it } from "vitest";
import {
  buildDesiredOzState,
  buildOzNetwork,
  buildRelayerEntry,
  mergeRpcUrls,
  networkApiId,
  rpcUrlsToWeightedPayload,
} from "../../scripts/lib/oz-desired-state.js";
import type { Registry } from "../../src/config/schema.js";

function minimalRegistry(chains: Registry["chains"]): Registry {
  return { version: 1, chains };
}

describe("oz-desired-state", () => {
  it("merges provider rpcUrls before public fallbacks with dedup", () => {
    expect(mergeRpcUrls(["https://private.example"], ["https://public.example", "https://private.example"])).toEqual([
      "https://private.example",
      "https://public.example",
    ]);
  });

  it("builds deterministic network and relayer ids for anvil", () => {
    const registry = minimalRegistry([
      {
        chainId: 31337,
        forwarderAddress: "0x0000000000000000000000000000000000000001",
        rpcUrls: ["http://anvil:8545"],
        macroPolicy: { mode: "open" },
      },
    ]);
    const desired = buildDesiredOzState(registry, {
      signerId: "prod-signer",
      relayerIdForAnvil: "anvil-relayer",
      nameForAnvil: "Anvil",
    });
    expect(desired.networks[0]!.network).toBe("localhost-anvil");
    expect(networkApiId("localhost-anvil")).toBe("evm:localhost-anvil");
    expect(desired.relayers[0]!.id).toBe("anvil-relayer");
    expect(desired.relayerIdByChainId.get(31337)).toBe("anvil-relayer");
  });

  it("builds clearmacro-prefixed relayer id for superfluid-backed chains", () => {
    const oz = buildOzNetwork({
      chainId: 11155420,
      forwarderAddress: "0x0000000000000000000000000000000000000001",
      rpcUrls: ["https://optimism-sepolia.rpc.example"],
      macroPolicy: { mode: "open" },
    });
    const relayer = buildRelayerEntry(oz, "prod-signer", { min_balance: 0 }, "anvil-relayer", "Anvil");
    expect(relayer.id).toBe("clearmacro-optimism-sepolia");
    expect(relayer.network).toBe("optimism-sepolia");
  });

  it("rpcUrlsToWeightedPayload assigns higher weight to first url", () => {
    expect(rpcUrlsToWeightedPayload(["https://a", "https://b"])).toEqual([
      { url: "https://a", weight: 100 },
      { url: "https://b", weight: 50 },
    ]);
  });

  it("macroPolicy changes do not alter desired OZ networks or relayers", () => {
    const baseChain = {
      chainId: 31337,
      forwarderAddress: "0x0000000000000000000000000000000000000001",
      rpcUrls: ["http://anvil:8545"],
    };
    const open = buildDesiredOzState(
      minimalRegistry([{ ...baseChain, macroPolicy: { mode: "open" } }]),
      { signerId: "prod-signer" },
    );
    const allowlist = buildDesiredOzState(
      minimalRegistry([
        {
          ...baseChain,
          macroPolicy: {
            mode: "allowlist",
            allowedMacros: [{ domain: "example", address: "0x2222222222222222222222222222222222222222" }],
          },
        },
      ]),
      { signerId: "prod-signer" },
    );
    expect(open.networks).toEqual(allowlist.networks);
    expect(open.relayers).toEqual(allowlist.relayers);
  });
});
