import { readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import type { AppEnv } from "./env.js";
import { RegistrySchema, type Registry, type RegistryChain, type RegistryClient } from "./schema.js";

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export type LoadedRegistry = {
  raw: Registry;
  chainsById: Map<number, RegistryChain>;
  clientsById: Map<string, RegistryClient>;
};

export function loadRegistry(env: Pick<AppEnv, "registryPath" | "defaultConfirmations">): LoadedRegistry {
  const file = readFileSync(env.registryPath, "utf8");
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
    chain.forwarders.clearMacroV1 = normalizeAddress(chain.forwarders.clearMacroV1);
    chain.forwarders.permit2ClearMacroV1 = normalizeAddress(chain.forwarders.permit2ClearMacroV1);
    chain.superfluidHost = normalizeAddress(chain.superfluidHost);
    for (const macro of chain.macros) {
      macro.address = normalizeAddress(macro.address);
    }
    if (chain.confirmations === undefined) {
      chain.confirmations = env.defaultConfirmations;
    }
    chainsById.set(chain.chainId, chain);
  }

  const clientsById = new Map<string, RegistryClient>();
  for (const client of registry.clients) {
    clientsById.set(client.id, client);
    client.allowedMacros = client.allowedMacros.map((a) => normalizeAddress(a));
  }

  return { raw: registry, chainsById, clientsById };
}

export function getChain(registry: LoadedRegistry, chainId: number): RegistryChain | undefined {
  return registry.chainsById.get(chainId);
}

export function resolveClient(registry: LoadedRegistry, clientId: string): RegistryClient | undefined {
  return registry.clientsById.get(clientId);
}

