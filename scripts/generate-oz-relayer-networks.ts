/**
 * Builds `config/oz-relayer/networks/evm.json` from `config/provider.json` plus
 * `@superfluid-finance/metadata` (chain names, testnet flag, native symbol, public RPCs).
 *
 * RPC order: provider-config `rpcUrls` first (for private endpoints), then Superfluid `publicRPCs`.
 * At least one URL is required per chain (set `rpcUrls` in provider config if metadata has none).
 *
 * Local Anvil (chainId 31337) is supported without Superfluid metadata when `rpcUrls` are set.
 *
 * Usage:
 *   pnpm run oz:gen:networks
 *   pnpm run oz:gen:networks -- path/to/provider.json
 *   pnpm run oz:gen:networks -- --dry-run
 *   pnpm run oz:gen:networks -- --update-config
 *
 * Env: PROVIDER_CONFIG_PATH, OZ_EVM_NETWORKS_OUT, OZ_RELAYER_CONFIG_PATH, OZ_RELAYER_SIGNER_ID
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import metadata from "@superfluid-finance/metadata";
import type { Registry } from "../src/config/schema.js";
import { RegistrySchema } from "../src/config/schema.js";

type OzEvmNetwork = {
  network: string;
  type: "evm";
  chain_id: number;
  is_testnet: boolean;
  required_confirmations: number;
  average_blocktime_ms: number;
  symbol: string;
  rpc_urls: string[];
};

type OzRelayerConfig = {
  relayers: {
    id: string;
    name: string;
    network: string;
    paused: boolean;
    signer_id: string;
    network_type: string;
    policies: { min_balance: number };
  }[];
  notifications: unknown[];
  signers: unknown[];
  networks: string;
  plugins: unknown[];
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

function defaultAverageBlocktimeMs(chainId: number): number {
  return AVERAGE_BLOCKTIME_MS[chainId] ?? 2_000;
}

function defaultRequiredConfirmations(chainId: number): number {
  return chainId === 1 ? 12 : 1;
}

function mergeRpcUrls(providerUrls: readonly string[], publicRpcs: readonly string[] | undefined): string[] {
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

function loadProviderConfig(providerConfigPath: string): Registry {
  const raw = JSON.parse(readFileSync(providerConfigPath, "utf8")) as unknown;
  if (!Value.Check(RegistrySchema, raw)) {
    const errs = [...Value.Errors(RegistrySchema, raw)];
    throw new Error(`Invalid provider config at ${providerConfigPath}: ${errs.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  }
  return raw as Registry;
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

function buildSfBackedNetwork(chain: Registry["chains"][number]): OzEvmNetwork {
  const sf = metadata.getNetworkByChainId(chain.chainId);
  if (!sf) {
    throw new Error(
      `chainId ${chain.chainId} is not in @superfluid-finance/metadata. ` +
        `Use a Superfluid-supported chain, or for local-only Anvil use chainId 31337 with rpcUrls.`,
    );
  }
  if (sf.isDeprecated) {
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

function buildOzNetwork(chain: Registry["chains"][number]): OzEvmNetwork {
  if (chain.chainId === 31337) {
    return buildAnvilNetwork(chain);
  }
  return buildSfBackedNetwork(chain);
}

function buildRelayerEntry(
  oz: OzEvmNetwork,
  signerId: string,
  policies: { min_balance: number },
  relayerIdForAnvil: string,
  nameForAnvil: string,
): OzRelayerConfig["relayers"][number] {
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

function parseFlags(argv: string[]): { positional: string[]; dryRun: boolean; updateConfig: boolean } {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  return {
    positional,
    dryRun: flags.has("--dry-run"),
    updateConfig: flags.has("--update-config"),
  };
}

function run(): void {
  const argv = process.argv.slice(2);
  const { positional, dryRun, updateConfig } = parseFlags(argv);

  const providerConfigPath = resolve(positional[0] ?? process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json");
  const outPath = resolve(process.env.OZ_EVM_NETWORKS_OUT ?? "config/oz-relayer/networks/evm.json");
  const configPath = resolve(process.env.OZ_RELAYER_CONFIG_PATH ?? "config/oz-relayer/config.json");

  const providerConfig = loadProviderConfig(providerConfigPath);
  const networks = providerConfig.chains.map((c) => buildOzNetwork(c));
  const payload = { networks };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath} (${networks.length} network(s)) from ${providerConfigPath}`);

  if (updateConfig) {
    const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as OzRelayerConfig;
    if (!Array.isArray(rawConfig.relayers) || !Array.isArray(rawConfig.signers)) {
      throw new Error(`Unexpected ${configPath} shape: expected relayers[] and signers[]`);
    }
    const template = rawConfig.relayers[0];
    const signerId = process.env.OZ_RELAYER_SIGNER_ID ?? template?.signer_id ?? "anvil-signer";
    const policies = template?.policies ?? { min_balance: 0 };
    const relayerIdForAnvil = template?.id ?? "anvil-relayer";
    const nameForAnvil = template?.name ?? "Local Anvil Relayer";

    rawConfig.relayers = networks.map((oz) => buildRelayerEntry(oz, signerId, policies, relayerIdForAnvil, nameForAnvil));
    writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
    console.log(`Updated relayers[] in ${configPath} (signer_id=${signerId})`);
  }
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
