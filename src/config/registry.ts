import { readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import type { Registry, RegistryChain } from "./schema.js";
import { RegistrySchema } from "./schema.js";

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export type LoadedRegistry = {
  raw: Registry;
  chainsById: Map<number, RegistryChain>;
  /** Populated at startup after querying OpenZeppelin Relayer. */
  relayerIdByChainId: Map<number, string>;
};

export function loadRegistry(registryPath: string): LoadedRegistry {
  const file = readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(file) as unknown;
  if (!Value.Check(RegistrySchema, parsed)) {
    throw new Error("Invalid registry JSON");
  }
  const registry = parsed as Registry;

  const chainsById = new Map<number, RegistryChain>();
  for (const chain of registry.chains) {
    if (chainsById.has(chain.chainId)) {
      throw new Error(`Duplicate chain id in registry: ${chain.chainId}`);
    }
    chain.forwarderAddress = normalizeAddress(chain.forwarderAddress);
    for (const macro of chain.allowedMacros) {
      macro.address = normalizeAddress(macro.address);
    }
    chainsById.set(chain.chainId, chain);
  }

  return { raw: registry, chainsById, relayerIdByChainId: new Map() };
}

export function getChain(registry: LoadedRegistry, chainId: number): RegistryChain | undefined {
  return registry.chainsById.get(chainId);
}
