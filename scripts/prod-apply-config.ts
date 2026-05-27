/**
 * Reconcile live OpenZeppelin Relayer state with config/provider.json (no Redis wipe).
 *
 * Usage:
 *   pnpm run prod:apply-config -- --dry-run
 *   pnpm run prod:apply-config
 *   pnpm run prod:apply-config -- --pause-removed-relayers
 *   pnpm run prod:apply-config -- --no-write-files
 *
 * App restart after apply is handled by the host wrapper (`prod-compose-admin`), not this script.
 * Use `pnpm run prod:apply-config -- --no-restart-app` to skip the host restart.
 *
 * Env: OZ_RELAYER_ADMIN_URL (optional; default http://oz-relayer:8080 in admin job), OZ_RELAYER_API_KEY,
 *      PROVIDER_CONFIG_PATH, OZ_RELAYER_CONFIG_PATH, OZ_EVM_NETWORKS_OUT
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import {
  applyReconcilePlan,
  buildReconcilePlan,
  formatPlanForConsole,
  validateRelayerBinding,
} from "./lib/oz-reconcile.js";
import {
  buildDesiredOzState,
  loadProviderConfigFromPath,
  writeOzNetworkFiles,
} from "./lib/oz-desired-state.js";
import { OzAdminClient } from "./lib/oz-admin-client.js";
import {
  assertOzRelayerAdminReachable,
  requireEnv,
  resolveOzRelayerAdminUrl,
} from "./lib/oz-admin-runtime.js";

dotenv.config();

function parseFlags(argv: string[]): {
  dryRun: boolean;
  pauseRemovedRelayers: boolean;
  writeFiles: boolean;
} {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  return {
    dryRun: flags.has("--dry-run"),
    pauseRemovedRelayers: flags.has("--pause-removed-relayers"),
    writeFiles: !flags.has("--no-write-files"),
  };
}

async function run(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const ozRelayerUrl = resolveOzRelayerAdminUrl();
  const ozApiKey = requireEnv("OZ_RELAYER_API_KEY");
  await assertOzRelayerAdminReachable(ozRelayerUrl);
  const timeoutMs = Number.parseInt(process.env.RELAYER_REQUEST_TIMEOUT_MS ?? "30000", 10);
  const providerConfigPath = resolve(process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json");
  const outPath = resolve(process.env.OZ_EVM_NETWORKS_OUT ?? "config/oz-relayer/networks/evm.json");
  const configPath = resolve(process.env.OZ_RELAYER_CONFIG_PATH ?? "config/oz-relayer/config.json");

  if (!existsSync(providerConfigPath)) {
    throw new Error(`Provider config not found: ${providerConfigPath}`);
  }

  const providerConfig = loadProviderConfigFromPath(providerConfigPath);
  const desired = buildDesiredOzState(providerConfig);
  const client = new OzAdminClient(ozRelayerUrl, ozApiKey, timeoutMs);

  const plan = await buildReconcilePlan(client, desired, {
    pauseRemovedRelayers: flags.pauseRemovedRelayers,
  });

  console.log(formatPlanForConsole(plan));
  if (plan.missingRelayerChainIds.length > 0) {
    console.warn(
      `Warning: chainIds still missing relayer after plan: ${plan.missingRelayerChainIds.join(", ")} (will retry create after network)`,
    );
  }

  const { applied, skipped } = await applyReconcilePlan(client, desired, plan, { dryRun: flags.dryRun });

  if (flags.dryRun) {
    if (flags.writeFiles) {
      console.log(`(dry-run) Would update ${outPath} and ${configPath} after successful apply`);
    }
    console.log(`Dry run: ${skipped.filter((a) => a.kind !== "noop").length} action(s) would be applied.`);
    return;
  }

  if (applied.length > 0) {
    console.log(`Applied ${applied.length} OZ reconciliation action(s).`);
  } else {
    console.log("No OZ API changes were required.");
  }

  await validateRelayerBinding(ozRelayerUrl, ozApiKey, providerConfigPath, timeoutMs);
  console.log("Relayer binding validation passed for all provider.json chains.");

  if (flags.writeFiles) {
    writeOzNetworkFiles(outPath, configPath, desired, true);
    console.log(`Updated ${outPath} and relayers[] in ${configPath}`);
  }
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
