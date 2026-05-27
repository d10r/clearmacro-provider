import { describe, expect, it, vi } from "vitest";
import type { DesiredOzState } from "../../scripts/lib/oz-desired-state.js";
import { networkApiId } from "../../scripts/lib/oz-desired-state.js";
import type { OzNetworkRecord } from "../../scripts/lib/oz-admin-client.js";
import { OzAdminClient } from "../../scripts/lib/oz-admin-client.js";
import { applyReconcilePlan, buildReconcilePlan } from "../../scripts/lib/oz-reconcile.js";

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
  networks?: OzNetworkRecord[];
  relayers?: Array<{
    id: string;
    paused?: boolean;
    system_disabled?: boolean;
    network_type?: string;
    network?: string;
  }>;
  networkById?: Record<string, OzNetworkRecord>;
}): OzAdminClient {
  const networks = live.networks ?? [];
  const relayers = live.relayers ?? [];
  const networkById = live.networkById ?? {};

  return {
    listNetworks: vi.fn(async () => networks),
    listRelayerIds: vi.fn(async () => relayers.map((r) => r.id)),
    getRelayer: vi.fn(async (id: string) => {
      const r = relayers.find((x) => x.id === id);
      if (!r) throw new Error("not found");
      return {
        address: "0x0000000000000000000000000000000000000001",
        paused: r.paused ?? false,
        system_disabled: r.system_disabled ?? false,
        network_type: r.network_type ?? "evm",
        network: r.network ?? "localhost-anvil",
      };
    }),
    getNetwork: vi.fn(async (apiId: string) => {
      if (networkById[apiId]) {
        return networkById[apiId]!;
      }
      const slug = apiId.replace(/^evm:/, "");
      const net = networks.find((n) => n.network === slug || n.id === apiId);
      if (!net) throw new Error("not found");
      return net;
    }),
    updateNetworkRpcUrls: vi.fn(async () => ({})),
    createRelayer: vi.fn(async () => ({})),
    updateRelayer: vi.fn(async () => ({})),
  } as unknown as OzAdminClient;
}

describe("buildReconcilePlan", () => {
  it("returns noop when live state matches desired", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: [{ url: "http://anvil:8545", weight: 100 }],
        },
      ],
      relayers: [{ id: "anvil-relayer", network_type: "evm", network: "localhost-anvil" }],
    });
    const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    expect(plan.actions.some((a) => a.kind === "noop")).toBe(true);
    expect(plan.actions.some((a) => a.kind === "bootstrap_required")).toBe(false);
  });

  it("plans bootstrap_required when OZ network is missing", async () => {
    const desired = desiredOneChain();
    const client = mockClient({ networks: [], relayers: [] });
    const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    expect(plan.actions.map((a) => a.kind)).toContain("bootstrap_required");
    expect(plan.actions.map((a) => a.kind)).not.toContain("create_relayer");
    expect(plan.bootstrapRequiredChainIds).toEqual([31337]);
    expect(plan.missingRelayerChainIds).toHaveLength(0);
  });

  it("plans patch_network_rpc when rpc urls differ", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://old:8545"],
        },
      ],
      relayers: [{ id: "anvil-relayer", network_type: "evm", network: "localhost-anvil" }],
    });
    const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    expect(plan.actions.some((a) => a.kind === "patch_network_rpc")).toBe(true);
  });

  it("fails on ambiguous duplicate live relayers", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
      ],
      relayers: [
        { id: "relayer-a", network_type: "evm", network: "localhost-anvil" },
        { id: "relayer-b", network_type: "evm", network: "localhost-anvil" },
      ],
    });
    await expect(buildReconcilePlan(client, desired, { pauseRemovedRelayers: false })).rejects.toThrow(
      /Multiple active OpenZeppelin relayers/,
    );
  });

  it("plans patch_relayer_unpause when desired relayer exists but is paused", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: [{ url: "http://anvil:8545", weight: 100 }],
        },
      ],
      relayers: [{ id: "anvil-relayer", paused: true, network_type: "evm", network: "localhost-anvil" }],
    });
    const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    expect(plan.actions.some((a) => a.kind === "patch_relayer_unpause" && a.relayerId === "anvil-relayer")).toBe(true);
    expect(plan.actions.some((a) => a.kind === "create_relayer")).toBe(false);
    expect(plan.missingRelayerChainIds).toHaveLength(0);
  });

  it("fails when desired relayer is system-disabled", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
      ],
      relayers: [
        { id: "anvil-relayer", paused: false, system_disabled: true, network_type: "evm", network: "localhost-anvil" },
      ],
    });
    await expect(buildReconcilePlan(client, desired, { pauseRemovedRelayers: false })).rejects.toThrow(
      /system-disabled/,
    );
  });

  it("fails before unpausing when another relayer is already active for the chain", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
      ],
      relayers: [
        { id: "anvil-relayer", paused: true, network_type: "evm", network: "localhost-anvil" },
        { id: "other-relayer", paused: false, network_type: "evm", network: "localhost-anvil" },
      ],
    });
    await expect(buildReconcilePlan(client, desired, { pauseRemovedRelayers: false })).rejects.toThrow(
      /would create multiple active relayers/,
    );
  });

  it("fails when a different active relayer exists for a desired chain", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
      ],
      relayers: [{ id: "other-relayer", paused: false, network_type: "evm", network: "localhost-anvil" }],
    });
    await expect(buildReconcilePlan(client, desired, { pauseRemovedRelayers: false })).rejects.toThrow(
      /provider\.json expects anvil-relayer/,
    );
  });

  it("plans pause for removed chains only with flag", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: ["http://anvil:8545"],
        },
        {
          id: "evm:polygon-mainnet",
          network: "polygon-mainnet",
          chain_id: 137,
          rpc_urls: ["http://polygon:8545"],
        },
      ],
      relayers: [
        { id: "anvil-relayer", network_type: "evm", network: "localhost-anvil" },
        { id: "clearmacro-polygon-mainnet", network_type: "evm", network: "polygon-mainnet" },
      ],
      networkById: {
        "evm:polygon-mainnet": {
          id: "evm:polygon-mainnet",
          network: "polygon-mainnet",
          chain_id: 137,
          rpc_urls: ["http://polygon:8545"],
        },
      },
    });
    const without = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    expect(without.actions.some((a) => a.kind === "patch_relayer_pause")).toBe(false);

    const withPause = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: true });
    expect(withPause.actions.some((a) => a.kind === "patch_relayer_pause" && a.chainId === 137)).toBe(true);
  });
});

describe("applyReconcilePlan", () => {
  it("dry-run does not call mutating APIs", async () => {
    const desired = desiredOneChain();
    const client = mockClient({ networks: [], relayers: [] });
    const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    const result = await applyReconcilePlan(client, desired, plan, { dryRun: true });
    expect(result.applied).toHaveLength(0);
    expect(client.createRelayer).not.toHaveBeenCalled();
  });

  it("non-dry-run fails before applying when bootstrap is required", async () => {
    const desired = desiredOneChain();
    const client = mockClient({ networks: [], relayers: [] });
    const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    await expect(applyReconcilePlan(client, desired, plan, { dryRun: false })).rejects.toThrow(/Bootstrap required/);
    expect(client.createRelayer).not.toHaveBeenCalled();
  });

  it("unpauses paused desired relayer via updateRelayer", async () => {
    const desired = desiredOneChain();
    const client = mockClient({
      networks: [
        {
          id: "evm:localhost-anvil",
          network: "localhost-anvil",
          chain_id: 31337,
          rpc_urls: [{ url: "http://anvil:8545", weight: 100 }],
        },
      ],
      relayers: [{ id: "anvil-relayer", paused: true, network_type: "evm", network: "localhost-anvil" }],
    });
    const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });
    const result = await applyReconcilePlan(client, desired, plan, { dryRun: false });
    expect(result.applied.some((a) => a.kind === "patch_relayer_unpause")).toBe(true);
    expect(client.updateRelayer).toHaveBeenCalledWith("anvil-relayer", { paused: false });
    expect(client.createRelayer).not.toHaveBeenCalled();
  });
});
