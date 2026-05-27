/**
 * Compare desired config (from provider.json) with live OZ Relayer API state.
 * Exits non-zero on drift that prod:apply-config would fix.
 */
import { resolve } from "node:path";
import dotenv from "dotenv";
import { buildDesiredOzStateFromPath } from "./lib/oz-desired-state.js";
import { OzAdminClient } from "./lib/oz-admin-client.js";
import { buildReconcilePlan, formatPlanForConsole, planNeedsOzMutation } from "./lib/oz-reconcile.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function run(): Promise<void> {
  const ozRelayerUrl = requireEnv("OZ_RELAYER_URL");
  const ozApiKey = requireEnv("OZ_RELAYER_API_KEY");
  const timeoutMs = Number.parseInt(process.env.RELAYER_REQUEST_TIMEOUT_MS ?? "30000", 10);
  const providerConfigPath = resolve(process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json");

  const desired = buildDesiredOzStateFromPath(providerConfigPath);
  const client = new OzAdminClient(ozRelayerUrl, ozApiKey, timeoutMs);
  const plan = await buildReconcilePlan(client, desired, { pauseRemovedRelayers: false });

  if (planNeedsOzMutation(plan)) {
    console.error(formatPlanForConsole(plan));
    throw new Error("Live OZ Relayer state drifts from provider.json. Run: pnpm run prod:apply-config");
  }

  console.log("Desired provider registry matches live OZ relayer state.");
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
