import { describe, expect, it, vi } from "vitest";
import type { DesiredOzState } from "../../scripts/lib/oz-desired-state.js";
import { networkApiId } from "../../scripts/lib/oz-desired-state.js";
import { OzRelayerHttpError } from "../../src/relayer/errors.js";
import type { OzNetworkRecord } from "../../scripts/lib/oz-admin-client.js";
import { OzAdminClient } from "../../scripts/lib/oz-admin-client.js";
import {
  OzImportVerificationError,
  assertOzImportMatchesDesired,
  formatOzImportMismatches,
  verifyDesiredOzImport,
} from "../../scripts/lib/oz-import-verify.js";

function desiredOneChain(): DesiredOzState {
  const network = {
    network: "localhost-anvil",
    type: "evm" as const,
    chain_id: 31337,
    is_testnet: true,
    required_confirmations: 1,
    average_blocktime_ms: 2000,
    symbol: "ETH",
    rpc_urls: ["http://anvil:8545"],
  };
  const relayer = {
    id: "anvil-relayer",
    name: "Anvil",
    network: "localhost-anvil",
    paused: false,
    signer_id: "prod-signer",
    network_type: "evm" as const,
    policies: { min_balance: 0 },
  };
  return {
    networks: [network],
    relayers: [relayer],
    relayerIdByChainId: new Map([[31337, "anvil-relayer"]]),
    networkApiIdByChainId: new Map([[31337, networkApiId("localhost-anvil")]]),
  };
}

function mockClient(live: {
  networks?: Record<string, OzNetworkRecord>;
  relayers?: Record<
    string,
    {
      paused?: boolean;
      system_disabled?: boolean;
      network_type?: string;
      network?: string;
      id?: string;
    }
  >;
}): OzAdminClient {
  const networks = live.networks ?? {};
  const relayers = live.relayers ?? {};

  return {
    getNetwork: vi.fn(async (apiId: string) => {
      const net = networks[apiId];
      if (!net) {
        throw new OzRelayerHttpError("not found", 404, `/api/v1/networks/${apiId}`);
      }
      return net;
    }),
    getRelayer: vi.fn(async (id: string) => {
      const r = relayers[id];
      if (!r) {
        throw new OzRelayerHttpError("not found", 404, `/api/v1/relayers/${id}`);
      }
      return {
        address: "0x0000000000000000000000000000000000000001",
        paused: r.paused ?? false,
        system_disabled: r.system_disabled ?? false,
        network_type: r.network_type ?? "evm",
        network: r.network ?? "localhost-anvil",
        id: r.id ?? id,
      };
    }),
  } as unknown as OzAdminClient;
}

describe("verifyDesiredOzImport", () => {
  it("passes when network and relayer match desired state", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: {
        "evm:localhost-anvil": {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          is_testnet: true,
          required_confirmations: 1,
          rpc_urls: [{ url: "http://anvil:8545", weight: 100 }],
        },
      },
      relayers: {
        "anvil-relayer": { network_type: "evm", network: "localhost-anvil" },
      },
    });
    const result = await verifyDesiredOzImport(client, desired);
    expect(result.ok).toBe(true);
    await expect(assertOzImportMatchesDesired(client, desired)).resolves.toBeUndefined();
  });

  it("reports missing network via direct GET", async () => {
    const desired = desiredOneChain();
    const client = mockClient({ networks: {}, relayers: {} });
    const result = await verifyDesiredOzImport(client, desired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches[0]?.message).toMatch(/network not found via GET/);
      expect(formatOzImportMismatches(result.mismatches)).toContain("OZ import mismatch:");
    }
    await expect(assertOzImportMatchesDesired(client, desired)).rejects.toBeInstanceOf(OzImportVerificationError);
  });

  it("reports wrong chain_id on live network", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: {
        "evm:localhost-anvil": {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 1,
          rpc_urls: ["http://anvil:8545"],
        },
      },
      relayers: {
        "anvil-relayer": { network_type: "evm", network: "localhost-anvil" },
      },
    });
    const result = await verifyDesiredOzImport(client, desired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => m.message.includes("chain_id=1"))).toBe(true);
    }
  });

  it("reports missing relayer", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: {
        "evm:localhost-anvil": {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
      },
      relayers: {},
    });
    const result = await verifyDesiredOzImport(client, desired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches[0]?.relayerId).toBe("anvil-relayer");
      expect(result.mismatches[0]?.message).toMatch(/relayer not found/);
    }
  });

  it("reports system_disabled relayer", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: {
        "evm:localhost-anvil": {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
      },
      relayers: {
        "anvil-relayer": { system_disabled: true, network_type: "evm", network: "localhost-anvil" },
      },
    });
    const result = await verifyDesiredOzImport(client, desired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches[0]?.message).toContain("system_disabled=true");
    }
  });

  it("reports paused relayer", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: {
        "evm:localhost-anvil": {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
      },
      relayers: {
        "anvil-relayer": { paused: true, network_type: "evm", network: "localhost-anvil" },
      },
    });
    const result = await verifyDesiredOzImport(client, desired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches[0]?.message).toContain("paused=true");
    }
  });

  it("reports RPC URL mismatch", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: {
        "evm:localhost-anvil": {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://old:8545"],
        },
      },
      relayers: {
        "anvil-relayer": { network_type: "evm", network: "localhost-anvil" },
      },
    });
    const result = await verifyDesiredOzImport(client, desired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => m.message.includes("RPC URLs differ"))).toBe(true);
    }
  });
});
