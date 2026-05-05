import { readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import type { Registry, RegistryChain } from "./schema.js";
import { RegistrySchema } from "./schema.js";

function formatRegistrySchemaErrors(parsed: unknown): string {
  const errors = [...Value.Errors(RegistrySchema, parsed)];
  return errors.map((e) => `${e.path.slice(1) || "(root)"}: ${e.message}`).join("; ");
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function normalizeDomain(domain: string): string {
  return domain.trim();
}

export type LoadedRegistry = {
  raw: Registry;
  chainsById: Map<number, RegistryChain>;
  /** Populated at startup after querying OpenZeppelin Relayer. */
  relayerIdByChainId: Map<number, string>;
  /** Populated at startup with `required_confirmations` from the bound relayer network (per chain). */
  requiredConfirmationsByChainId: Map<number, number>;
};

export function loadRegistry(registryPath: string): LoadedRegistry {
  const file = readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(file) as unknown;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { chains?: unknown }).chains)) {
    const chains = (parsed as { chains: unknown[] }).chains;
    for (const [index, chain] of chains.entries()) {
      if (chain && typeof chain === "object" && "allowedMacros" in chain) {
        throw new Error(`Invalid registry JSON: chains[] must not define top-level allowedMacros (chain index ${index})`);
      }
    }
  }
  if (!Value.Check(RegistrySchema, parsed)) {
    throw new Error(`Invalid registry JSON: ${formatRegistrySchemaErrors(parsed)}`);
  }
  const registry = parsed as Registry;

  const chainsById = new Map<number, RegistryChain>();
  for (const chain of registry.chains) {
    if (chainsById.has(chain.chainId)) {
      throw new Error(`Duplicate chain id in registry: ${chain.chainId}`);
    }
    chain.forwarderAddress = normalizeAddress(chain.forwarderAddress);
    if (chain.macroPolicy.mode === "allowlist") {
      const seen = new Set<string>();
      for (const macro of chain.macroPolicy.allowedMacros) {
        macro.domain = normalizeDomain(macro.domain);
        if (macro.domain.length === 0) {
          throw new Error(`Invalid macro allowlist entry for chain ${chain.chainId}: domain must not be empty`);
        }
        macro.address = normalizeAddress(macro.address);
        const key = `${macro.domain}::${macro.address}`;
        if (seen.has(key)) {
          throw new Error(`Duplicate macro allowlist entry for chain ${chain.chainId}: (${macro.domain}, ${macro.address})`);
        }
        seen.add(key);
      }
    }
    chainsById.set(chain.chainId, chain);
  }

  return { raw: registry, chainsById, relayerIdByChainId: new Map(), requiredConfirmationsByChainId: new Map() };
}

export function getChain(registry: LoadedRegistry, chainId: number): RegistryChain | undefined {
  return registry.chainsById.get(chainId);
}
