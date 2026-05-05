import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import dotenv from "dotenv";

dotenv.config();

const LOCAL_DEFAULTS = new Set([
  "local-oz-relayer-api-key-32chars",
  "local-webhook-signing-key",
  "change-me",
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
]);

type OzRelayerConfig = {
  relayers?: unknown;
  signers?: unknown;
  networks?: unknown;
};

function fail(message: string): never {
  throw new Error(message);
}

function requireSecret(name: string): void {
  const value = process.env[name];
  if (!value) fail(`Missing required env var: ${name}`);
  if (LOCAL_DEFAULTS.has(value)) fail(`${name} is still using a local/default value`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

function run(): void {
  requireSecret("PROVIDER_NAME");
  requireSecret("OZ_RELAYER_API_KEY");
  requireSecret("OZ_WEBHOOK_SIGNING_KEY");
  requireSecret("OZ_KEYSTORE_PASSPHRASE");
  requireSecret("OZ_STORAGE_ENCRYPTION_KEY");

  const registryPath = resolve(process.env.REGISTRY_PATH ?? "config/registry.json");
  const relayerConfigPath = resolve(process.env.OZ_RELAYER_CONFIG_PATH ?? "config/oz-relayer/config.json");
  const networksOutPath = resolve(process.env.OZ_EVM_NETWORKS_OUT ?? "config/oz-relayer/networks/evm.json");
  const keystorePath = resolve(process.env.OZ_RELAYER_KEYSTORE_PATH ?? "config/oz-relayer/keys/prod-relayer.json");
  const ozConfigDir = resolve("config/oz-relayer");

  for (const path of [registryPath, relayerConfigPath, networksOutPath, keystorePath]) {
    if (!existsSync(path)) fail(`Missing required file: ${path}`);
  }
  if (!inside(ozConfigDir, keystorePath)) {
    fail(`OZ_RELAYER_KEYSTORE_PATH must be under ${ozConfigDir}`);
  }

  const config = readJson(relayerConfigPath) as OzRelayerConfig;
  if (!Array.isArray(config.signers) || config.signers.length !== 1) {
    fail(`Expected exactly one signer in ${relayerConfigPath}`);
  }
  if (!Array.isArray(config.relayers) || config.relayers.length < 1) {
    fail(`Expected at least one relayer in ${relayerConfigPath}`);
  }
  if (config.networks !== "/app/config/networks") {
    fail(`${relayerConfigPath} must point networks to /app/config/networks`);
  }

  const signer = config.signers[0] as { type?: unknown; config?: { path?: unknown; passphrase?: { value?: unknown } } };
  if (signer.type !== "local") fail("Only local signer config is supported by prod:init/prod:validate");
  if (signer.config?.passphrase?.value !== "OZ_KEYSTORE_PASSPHRASE") {
    fail("Signer passphrase must reference OZ_KEYSTORE_PASSPHRASE");
  }
  const expectedPathInContainer = `./config/${relative(ozConfigDir, keystorePath).replaceAll(sep, "/")}`;
  if (signer.config?.path !== expectedPathInContainer) {
    fail("Signer keystore path does not match OZ_RELAYER_KEYSTORE_PATH");
  }

  const networks = readJson(networksOutPath) as { networks?: unknown };
  if (!Array.isArray(networks.networks) || networks.networks.length !== config.relayers.length) {
    fail("Generated OZ networks count must match relayers count");
  }

  console.log("Production config validation passed.");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
