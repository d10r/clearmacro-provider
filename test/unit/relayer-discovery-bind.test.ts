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
  getNetwork: (type: string, net: string) => Promise<{ id: string; network_type: string; required_confirmations: number }>;
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
});
