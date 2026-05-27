/**
 * Verify live OpenZeppelin Relayer import matches config/provider.json before starting app.
 *
 * Uses direct GET per network/relayer (not paginated list endpoints). Also runs the
 * same relayer binding check the app performs at startup.
 */
import { resolve } from "node:path";
import dotenv from "dotenv";
import { buildDesiredOzStateFromPath } from "./lib/oz-desired-state.js";
import { assertOzImportMatchesDesired } from "./lib/oz-import-verify.js";
import { OzAdminClient } from "./lib/oz-admin-client.js";
import {
  assertOzRelayerAdminReachable,
  requireEnv,
  resolveOzRelayerAdminUrl,
} from "./lib/oz-admin-runtime.js";
import { validateRelayerBinding } from "./lib/oz-reconcile.js";

dotenv.config();

async function run(): Promise<void> {
  const ozRelayerUrl = resolveOzRelayerAdminUrl();
  const ozApiKey = requireEnv("OZ_RELAYER_API_KEY");
  await assertOzRelayerAdminReachable(ozRelayerUrl);
  const timeoutMs = Number.parseInt(process.env.RELAYER_REQUEST_TIMEOUT_MS ?? "30000", 10);
  const providerConfigPath = resolve(process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json");

  const desired = buildDesiredOzStateFromPath(providerConfigPath);
  const client = new OzAdminClient(ozRelayerUrl, ozApiKey, timeoutMs);

  await assertOzImportMatchesDesired(client, desired);
  await validateRelayerBinding(ozRelayerUrl, ozApiKey, providerConfigPath, timeoutMs);

  console.log(
    `OpenZeppelin import verified: ${desired.networks.length} network(s), ${desired.relayers.length} relayer(s), relayer binding OK.`,
  );
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
