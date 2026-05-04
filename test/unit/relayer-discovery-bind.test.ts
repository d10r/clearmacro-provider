import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../src/config/registry.js";
import { bindRelayersToRegistry } from "../../src/config/relayerDiscovery.js";
import type { OzRelayerClient } from "../../src/relayer/client.js";

function writeMinimalRegistry(dir: string, chainId = 1) {
  const path = join(dir, "registry.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: ["http://localhost:8545"],
          allowedMacros: [{ domain: "t", address: "0x0000000000000000000000000000000000000002" }],
        },
      ],
    }),
  );
  return path;
}

function mockClient(handlers: {
  listRelayerIds: () => Promise<string[]>;
  getRelayer: (id: string) => Promise<{
    paused: boolean;
    system_disabled: boolean;
    network_type?: string | null;
    network?: string | null;
  }>;
  getNetwork: (
    type: string,
    net: string,
  ) => Promise<{ id: string; network_type: string; chain_id?: number; required_confirmations: number | null }>;
}): OzRelayerClient {
  return {
    listRelayerIds: handlers.listRelayerIds,
    getRelayer: handlers.getRelayer,
    getNetwork: handlers.getNetwork,
  } as unknown as OzRelayerClient;
}

describe("bindRelayersToRegistry", () => {
  it("binds the single matching relayer per chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-ok-"));
    const registry = loadRegistry(writeMinimalRegistry(dir));
    const client = mockClient({
      listRelayerIds: async () => ["r-main"],
      getRelayer: async () => ({
        paused: false,
        system_disabled: false,
        network_type: "evm",
        network: "1",
      }),
      getNetwork: async () => ({
        id: "eip155:1",
        network_type: "evm",
        required_confirmations: 1,
      }),
    });
    await bindRelayersToRegistry(registry, client);
    expect(registry.relayerIdByChainId.get(1)).toBe("r-main");
    expect(registry.requiredConfirmationsByChainId.get(1)).toBe(1);
  });

  it("throws when no relayer matches a configured chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-none-"));
    const registry = loadRegistry(writeMinimalRegistry(dir));
    const client = mockClient({
      listRelayerIds: async () => ["r-x"],
      getRelayer: async () => ({
        paused: false,
        system_disabled: false,
        network_type: "evm",
        network: "999",
      }),
      getNetwork: async () => ({
        id: "eip155:999",
        network_type: "evm",
        required_confirmations: 1,
      }),
    });
    await expect(bindRelayersToRegistry(registry, client)).rejects.toThrow(/No active OpenZeppelin relayer matches/);
  });

  it("throws when multiple relayers match the same chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-dup-"));
    const registry = loadRegistry(writeMinimalRegistry(dir));
    const client = mockClient({
      listRelayerIds: async () => ["r-a", "r-b"],
      getRelayer: async (id) => ({
        paused: false,
        system_disabled: false,
        network_type: "evm",
        network: id,
      }),
      getNetwork: async () => ({
        id: "eip155:1",
        network_type: "evm",
        required_confirmations: 1,
      }),
    });
    await expect(bindRelayersToRegistry(registry, client)).rejects.toThrow(/Multiple OpenZeppelin relayers match/);
  });

  it("ignores paused relayers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-paused-"));
    const registry = loadRegistry(writeMinimalRegistry(dir));
    const client = mockClient({
      listRelayerIds: async () => ["r-paused"],
      getRelayer: async () => ({
        paused: true,
        system_disabled: false,
        network_type: "evm",
        network: "1",
      }),
      getNetwork: async () => ({
        id: "eip155:1",
        network_type: "evm",
        required_confirmations: 1,
      }),
    });
    await expect(bindRelayersToRegistry(registry, client)).rejects.toThrow(/No active OpenZeppelin relayer matches/);
  });

  it("stores required_confirmations from the bound relayer network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-rc-"));
    const registry = loadRegistry(writeMinimalRegistry(dir));
    const client = mockClient({
      listRelayerIds: async () => ["r-main"],
      getRelayer: async () => ({
        paused: false,
        system_disabled: false,
        network_type: "evm",
        network: "1",
      }),
      getNetwork: async () => ({
        id: "eip155:1",
        network_type: "evm",
        required_confirmations: 12,
      }),
    });
    await bindRelayersToRegistry(registry, client);
    expect(registry.requiredConfirmationsByChainId.get(1)).toBe(12);
  });

  it("binds when OZ exposes chain_id even if id is not a numeric eip155/evm pattern", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-chain-id-"));
    const registry = loadRegistry(writeMinimalRegistry(dir));
    const client = mockClient({
      listRelayerIds: async () => ["r-main"],
      getRelayer: async () => ({
        paused: false,
        system_disabled: false,
        network_type: "evm",
        network: "mainnet",
      }),
      getNetwork: async () => ({
        id: "evm:mainnet",
        network_type: "evm",
        chain_id: 1,
        required_confirmations: 2,
      }),
    });
    await bindRelayersToRegistry(registry, client);
    expect(registry.relayerIdByChainId.get(1)).toBe("r-main");
    expect(registry.requiredConfirmationsByChainId.get(1)).toBe(2);
  });

  it("throws when required_confirmations is not a positive integer after relayer match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-bad-rc-"));
    const registry = loadRegistry(writeMinimalRegistry(dir));
    let getNetworkCalls = 0;
    const client = mockClient({
      listRelayerIds: async () => ["r-main"],
      getRelayer: async () => ({
        paused: false,
        system_disabled: false,
        network_type: "evm",
        network: "1",
      }),
      getNetwork: async () => {
        getNetworkCalls++;
        if (getNetworkCalls === 1) {
          return { id: "eip155:1", network_type: "evm", required_confirmations: 1 };
        }
        return { id: "eip155:1", network_type: "evm", required_confirmations: 0 };
      },
    });
    await expect(bindRelayersToRegistry(registry, client)).rejects.toThrow(/invalid required_confirmations/);
  });
});
