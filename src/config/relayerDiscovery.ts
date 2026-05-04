import type { LoadedRegistry } from "./registry.js";
import type { OzNetwork, OzRelayerClient } from "../relayer/client.js";

export function parseEvmChainIdFromNetwork(network: OzNetwork): number | null {
  const chainId = network.chain_id;
  if (typeof chainId === "number" && Number.isInteger(chainId) && chainId >= 1) {
    return chainId;
  }
  const id = network.id ?? "";
  const eip155 = /^eip155:(\d+)$/i.exec(id);
  if (eip155) {
    return Number(eip155[1]);
  }
  const evmNumeric = /^evm:(\d+)$/i.exec(id);
  if (evmNumeric) {
    return Number(evmNumeric[1]);
  }
  return null;
}

/**
 * Queries the relayer API and binds exactly one active relayer id per configured chain.
 * Throws if a chain matches zero or multiple relayers.
 */
export async function bindRelayersToRegistry(registry: LoadedRegistry, client: OzRelayerClient): Promise<void> {
  const relayerIds = await client.listRelayerIds();
  const matchesByChain = new Map<number, string[]>();

  for (const chainId of registry.chainsById.keys()) {
    matchesByChain.set(chainId, []);
  }

  for (const relayerId of relayerIds) {
    let details;
    try {
      details = await client.getRelayer(relayerId);
    } catch {
      continue;
    }
    if (details.paused || details.system_disabled) {
      continue;
    }
    if (!details.network_type || !details.network) {
      continue;
    }
    let network: OzNetwork;
    try {
      network = await client.getNetwork(details.network_type, details.network);
    } catch {
      continue;
    }
    const parsed = parseEvmChainIdFromNetwork(network);
    if (parsed === null) {
      continue;
    }
    if (!matchesByChain.has(parsed)) {
      continue;
    }
    matchesByChain.get(parsed)!.push(relayerId);
  }

  for (const [chainId, matches] of matchesByChain) {
    if (matches.length === 0) {
      throw new Error(`No active OpenZeppelin relayer matches registry chainId ${chainId}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple OpenZeppelin relayers match registry chainId ${chainId}: ${matches.join(", ")}. Resolve operationally.`,
      );
    }
    registry.relayerIdByChainId.set(chainId, matches[0]!);
  }

  registry.requiredConfirmationsByChainId.clear();
  for (const chainId of registry.chainsById.keys()) {
    const relayerId = registry.relayerIdByChainId.get(chainId);
    if (!relayerId) {
      throw new Error(`Internal: missing relayer id binding for chainId ${chainId}`);
    }
    const details = await client.getRelayer(relayerId);
    if (!details.network_type || !details.network) {
      throw new Error(
        `OpenZeppelin relayer ${relayerId} for registry chainId ${chainId} is missing network_type/network; cannot read required_confirmations`,
      );
    }
    const network = await client.getNetwork(details.network_type, details.network);
    const rc = network.required_confirmations;
    if (rc == null || typeof rc !== "number" || !Number.isInteger(rc) || rc < 1) {
      throw new Error(
        `OpenZeppelin network for registry chainId ${chainId} returned invalid required_confirmations (expected positive integer)`,
      );
    }
    registry.requiredConfirmationsByChainId.set(chainId, rc);
  }
}
