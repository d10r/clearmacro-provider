/**
 * Builds `config/oz-relayer/networks/evm.json` from `config/provider.json` plus
 * `@superfluid-finance/metadata` (chain names, testnet flag, native symbol).
 *
 * OZ uses the provider-config `rpcUrls` entries as the operator-curated RPC list.
 * Keep every listed URL production-grade.
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
 *
 * Note: this updates files on disk only. After first OZ Relayer boot with Redis persistence,
 * apply live changes with `pnpm run prod:apply-config`.
 */
import { resolve } from "node:path";
import {
  buildDesiredOzState,
  loadProviderConfigFromPath,
  writeOzNetworkFiles,
} from "./lib/oz-desired-state.js";

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

  const providerConfig = loadProviderConfigFromPath(providerConfigPath);
  const desired = buildDesiredOzState(providerConfig);

  if (dryRun) {
    console.log(JSON.stringify({ networks: desired.networks, relayers: desired.relayers }, null, 2));
    return;
  }

  writeOzNetworkFiles(outPath, configPath, desired, updateConfig);
  console.log(`Wrote ${outPath} (${desired.networks.length} network(s)) from ${providerConfigPath}`);
  if (updateConfig) {
    const signerId = process.env.OZ_RELAYER_SIGNER_ID ?? desired.relayers[0]?.signer_id ?? "prod-signer";
    console.log(`Updated relayers[] in ${configPath} (signer_id=${signerId})`);
  }
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
