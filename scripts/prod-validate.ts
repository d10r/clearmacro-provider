import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import dotenv from "dotenv";
import { Keystore } from "ox";
import { privateKeyToAccount } from "viem/accounts";

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

type ProviderConfig = {
  chains: {
    chainId: number;
    rpcUrls: string[];
    macroPolicy?: { mode?: string };
  }[];
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

function readSignerAddressFromKeystore(keystorePath: string, passphrase: string): string {
  const keystore = readJson(keystorePath) as Parameters<typeof Keystore.toKey>[0];
  const key = Keystore.toKey(keystore, { password: passphrase });
  const privateKey = Keystore.decrypt(keystore, key);
  return privateKeyToAccount(privateKey).address;
}

async function readNativeBalance(rpcUrl: string, address: string): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { result?: string; error?: { message?: string } };
  if (payload.error) {
    throw new Error(payload.error.message ?? "Unknown JSON-RPC error");
  }
  if (!payload.result || !/^0x[0-9a-fA-F]+$/.test(payload.result)) {
    throw new Error("Invalid eth_getBalance response");
  }
  return BigInt(payload.result);
}

function formatEthFromWei(wei: bigint): string {
  const base = 10n ** 18n;
  const whole = wei / base;
  const fractional = wei % base;
  const fractional4 = fractional / 10n ** 14n;
  return `${whole}.${fractional4.toString().padStart(4, "0")} ETH`;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

async function run(): Promise<void> {
  requireSecret("PROVIDER_NAME");
  requireSecret("OZ_RELAYER_API_KEY");
  requireSecret("OZ_WEBHOOK_SIGNING_KEY");
  requireSecret("OZ_KEYSTORE_PASSPHRASE");
  requireSecret("OZ_STORAGE_ENCRYPTION_KEY");

  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    requireSecret("OZ_RELAYER_UID");
    requireSecret("OZ_RELAYER_GID");
  }

  const providerConfigPathValue = process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json";
  const providerConfigPath = resolve(providerConfigPathValue);
  const relayerConfigPath = resolve(process.env.OZ_RELAYER_CONFIG_PATH ?? "config/oz-relayer/config.json");
  const networksOutPath = resolve(process.env.OZ_EVM_NETWORKS_OUT ?? "config/oz-relayer/networks/evm.json");
  const keystorePath = resolve(process.env.OZ_RELAYER_KEYSTORE_PATH ?? "config/oz-relayer/keys/prod-relayer.json");
  const ozConfigDir = resolve("config/oz-relayer");

  for (const path of [providerConfigPath, relayerConfigPath, networksOutPath, keystorePath]) {
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

  const signerAddress = readSignerAddressFromKeystore(keystorePath, process.env.OZ_KEYSTORE_PASSPHRASE ?? "");
  const providerConfig = readJson(providerConfigPath) as ProviderConfig;
  console.log(`Signer address: ${signerAddress}`);
  console.log("Configured chain balances:");
  for (const chain of providerConfig.chains) {
    const mode = chain.macroPolicy?.mode ?? "unknown";
    const rpcUrl = chain.rpcUrls[0];
    if (!rpcUrl) {
      console.log(`- chainId=${chain.chainId} mode=${mode}: no rpcUrls configured`);
      continue;
    }
    try {
      const balanceWei = await readNativeBalance(rpcUrl, signerAddress);
      console.log(`- chainId=${chain.chainId} mode=${mode} rpc=${rpcUrl} balance=${formatEthFromWei(balanceWei)}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`- chainId=${chain.chainId} mode=${mode} rpc=${rpcUrl} balance=unavailable (${reason})`);
    }
  }

  console.log("Production config validation passed.");
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
