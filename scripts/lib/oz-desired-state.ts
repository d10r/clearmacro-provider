/**
 * Builds desired OpenZeppelin Relayer networks/relayers from provider registry JSON.
 * Shared by oz:gen:networks and prod:apply-config.
 */
import { readFileSync, writeFileSync } from "node:fs";
import metadata from "@superfluid-finance/metadata";
import { loadRegistry } from "../../src/config/registry.js";
import type { Registry } from "../../src/config/schema.js";

export type OzEvmNetwork = {
  network: string;
  type: "evm";
  chain_id: number;
  is_testnet: boolean;
  required_confirmations: number;
  average_blocktime_ms: number;
  symbol: string;
  rpc_urls: string[];
};

export type OzRelayerEntry = {
  id: string;
  name: string;
  network: string;
  paused: boolean;
  signer_id: string;
  network_type: "evm";
  policies: { min_balance: number };
};

export type DesiredOzState = {
  networks: OzEvmNetwork[];
  relayers: OzRelayerEntry[];
  /** chainId -> relayer id */
  relayerIdByChainId: Map<number, string>;
  /** chainId -> OZ network API id (`evm:<slug>`) */
  networkApiIdByChainId: Map<number, string>;
};

export type BuildDesiredOzStateOptions = {
  signerId?: string;
  policies?: { min_balance: number };
  relayerIdForAnvil?: string;
  nameForAnvil?: string;
};

const AVERAGE_BLOCKTIME_MS: Record<number, number> = {
  1: 12_000,
  10: 2_000,
  56: 2_000,
  100: 2_000,
  137: 2_000,
  8453: 2_000,
  42161: 250,
  43114: 2_000,
  11155111: 12_000,
  84532: 2_000,
  421614: 250,
};

export function defaultAverageBlocktimeMs(chainId: number): number {
  return AVERAGE_BLOCKTIME_MS[chainId] ?? 2_000;
}

export function defaultRequiredConfirmations(chainId: number): number {
  return chainId === 1 ? 12 : 1;
}

export function mergeRpcUrls(providerUrls: readonly string[], publicRpcs: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of providerUrls) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  for (const u of publicRpcs ?? []) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

export function networkApiId(networkSlug: string): string {
  return `evm:${networkSlug}`;
}

export function rpcUrlsToWeightedPayload(urls: readonly string[]): { url: string; weight: number }[] {
  return urls.map((url, index) => ({
    url,
    weight: index === 0 ? 100 : 50,
  }));
}

export function loadProviderConfigFromPath(providerConfigPath: string): Registry {
  return loadRegistry(providerConfigPath).raw;
}

function buildAnvilNetwork(chain: Registry["chains"][number]): OzEvmNetwork {
  const rpc_urls = mergeRpcUrls(chain.rpcUrls, undefined);
  if (rpc_urls.length === 0) {
    throw new Error(
      `Provider config chainId 31337 (Anvil): set "rpcUrls" on the chain (e.g. ["http://anvil:8545"] for Docker compose).`,
    );
  }
  return {
    network: "localhost-anvil",
    type: "evm",
    chain_id: 31337,
    is_testnet: true,
    required_confirmations: 1,
    average_blocktime_ms: defaultAverageBlocktimeMs(31337),
    symbol: "ETH",
    rpc_urls,
  };
}

function buildSfBackedNetwork(chain: Registry["chains"][number], warnDeprecated = true): OzEvmNetwork {
  const sf = metadata.getNetworkByChainId(chain.chainId);
  if (!sf) {
    throw new Error(
      `chainId ${chain.chainId} is not in @superfluid-finance/metadata. ` +
        `Use a Superfluid-supported chain, or for local-only Anvil use chainId 31337 with rpcUrls.`,
    );
  }
  if (warnDeprecated && sf.isDeprecated) {
    console.warn(`Warning: Superfluid marks ${sf.name} (chainId ${chain.chainId}) as deprecated.`);
  }
  const rpc_urls = mergeRpcUrls(chain.rpcUrls, sf.publicRPCs);
  if (rpc_urls.length === 0) {
    throw new Error(
      `chainId ${chain.chainId} (${sf.name}): no RPC URLs. Add "rpcUrls" to this chain in provider config, or ensure metadata lists publicRPCs.`,
    );
  }
  return {
    network: sf.name,
    type: "evm",
    chain_id: sf.chainId,
    is_testnet: sf.isTestnet,
    required_confirmations: defaultRequiredConfirmations(sf.chainId),
    average_blocktime_ms: defaultAverageBlocktimeMs(sf.chainId),
    symbol: sf.nativeTokenSymbol,
    rpc_urls,
  };
}

export function buildOzNetwork(chain: Registry["chains"][number], warnDeprecated = true): OzEvmNetwork {
  if (chain.chainId === 31337) {
    return buildAnvilNetwork(chain);
  }
  return buildSfBackedNetwork(chain, warnDeprecated);
}

export function buildRelayerEntry(
  oz: OzEvmNetwork,
  signerId: string,
  policies: { min_balance: number },
  relayerIdForAnvil: string,
  nameForAnvil: string,
): OzRelayerEntry {
  if (oz.network === "localhost-anvil") {
    return {
      id: relayerIdForAnvil,
      name: nameForAnvil,
      network: oz.network,
      paused: false,
      signer_id: signerId,
      network_type: "evm",
      policies,
    };
  }
  const safeId = `clearmacro-${oz.network.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
  return {
    id: safeId,
    name: `ClearMacro ${oz.network}`,
    network: oz.network,
    paused: false,
    signer_id: signerId,
    network_type: "evm",
    policies,
  };
}

export function buildDesiredOzState(providerConfig: Registry, opts: BuildDesiredOzStateOptions = {}): DesiredOzState {
  const signerId = opts.signerId ?? process.env.OZ_RELAYER_SIGNER_ID ?? "prod-signer";
  const policies = opts.policies ?? { min_balance: 0 };
  const relayerIdForAnvil = opts.relayerIdForAnvil ?? "anvil-relayer";
  const nameForAnvil = opts.nameForAnvil ?? "Local Anvil Relayer";

  const networks = providerConfig.chains.map((c) => buildOzNetwork(c));
  const relayers = networks.map((oz) => buildRelayerEntry(oz, signerId, policies, relayerIdForAnvil, nameForAnvil));

  const relayerIdByChainId = new Map<number, string>();
  const networkApiIdByChainId = new Map<number, string>();
  for (const oz of networks) {
    relayerIdByChainId.set(oz.chain_id, relayers.find((r) => r.network === oz.network)!.id);
    networkApiIdByChainId.set(oz.chain_id, networkApiId(oz.network));
  }

  return { networks, relayers, relayerIdByChainId, networkApiIdByChainId };
}

export function buildDesiredOzStateFromPath(
  providerConfigPath: string,
  opts: BuildDesiredOzStateOptions = {},
): DesiredOzState {
  return buildDesiredOzState(loadProviderConfigFromPath(providerConfigPath), opts);
}

export function writeOzNetworkFiles(
  outPath: string,
  configPath: string,
  desired: DesiredOzState,
  updateConfig: boolean,
): void {
  writeFileSync(outPath, `${JSON.stringify({ networks: desired.networks }, null, 2)}\n`, "utf8");

  if (!updateConfig) {
    return;
  }

  const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
    relayers: unknown[];
    signers: unknown[];
    notifications?: unknown[];
    networks: string;
    plugins?: unknown[];
  };
  if (!Array.isArray(rawConfig.relayers) || !Array.isArray(rawConfig.signers)) {
    throw new Error(`Unexpected ${configPath} shape: expected relayers[] and signers[]`);
  }
  rawConfig.relayers = desired.relayers;
  writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
}
