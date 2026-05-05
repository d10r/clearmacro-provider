import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { Keystore, Secp256k1 } from "ox";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");

type OzRelayerConfig = {
  relayers: unknown[];
  notifications: unknown[];
  signers: {
    id: string;
    type: "local";
    config: {
      path: string;
      passphrase: { type: "env"; value: "OZ_KEYSTORE_PASSPHRASE" };
    };
  }[];
  networks: string;
  plugins: unknown[];
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running prod:init`);
  return value;
}

function ensureEnvSecret(name: string, value: string): void {
  if (process.env[name]) return;
  const envPath = resolve(".env");
  appendFileSync(envPath, `${existsSync(envPath) ? "\n" : ""}${name}=${value}\n`, { mode: 0o600 });
  process.env[name] = value;
  console.log(`Generated ${name} and wrote it to .env`);
}

function generateKeystorePassphrase(): string {
  return `Cm-${randomBytes(32).toString("base64url")}-1aA!`;
}

function generateWebhookSigningKey(): string {
  return randomBytes(32).toString("base64url");
}

function generateStorageEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

async function generateRelayerKeystore(keystorePath: string, passphrase: string): Promise<void> {
  const privateKey = Secp256k1.randomPrivateKey();
  const [key, options] = await Keystore.scryptAsync({
    password: passphrase,
    n: 8192,
    p: 1,
    r: 8,
  });
  const keystore = Keystore.encrypt(privateKey, key, options);
  writeFileSync(keystorePath, `${JSON.stringify(keystore)}\n`, { mode: 0o600 });

  // Log signer address only; never log raw private key.
  const account = privateKeyToAccount(privateKey);
  console.log(`Generated relayer signer address: ${account.address}`);
}

function readRelayerSignerAddress(keystorePath: string, passphrase: string): string {
  const keystore = JSON.parse(readFileSync(keystorePath, "utf8")) as Parameters<typeof Keystore.toKey>[0];
  const key = Keystore.toKey(keystore, { password: passphrase });
  const privateKey = Keystore.decrypt(keystore, key);
  const account = privateKeyToAccount(privateKey);
  return account.address;
}

async function run(): Promise<void> {
  const force = process.argv.includes("--force");
  if (force) {
    throw new Error(
      "--force is not supported by prod:init because signer rotation is not implemented; remove --force and manage signer rotation manually.",
    );
  }
  ensureEnvSecret("OZ_RELAYER_API_KEY", randomBytes(32).toString("base64url"));
  ensureEnvSecret("OZ_KEYSTORE_PASSPHRASE", generateKeystorePassphrase());
  ensureEnvSecret("OZ_WEBHOOK_SIGNING_KEY", generateWebhookSigningKey());
  ensureEnvSecret("OZ_STORAGE_ENCRYPTION_KEY", generateStorageEncryptionKey());
  const passphrase = requireEnv("OZ_KEYSTORE_PASSPHRASE");
  const providerConfigPathValue = process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json";
  const providerConfigPath = resolve(providerConfigPathValue);
  const relayerConfigPath = resolve(process.env.OZ_RELAYER_CONFIG_PATH ?? "config/oz-relayer/config.json");
  const networksOutPath = resolve(process.env.OZ_EVM_NETWORKS_OUT ?? "config/oz-relayer/networks/evm.json");
  const keystorePath = resolve(process.env.OZ_RELAYER_KEYSTORE_PATH ?? "config/oz-relayer/keys/prod-relayer.json");
  const signerId = process.env.OZ_RELAYER_SIGNER_ID ?? "prod-signer";

  if (!existsSync(providerConfigPath)) {
    throw new Error(`Provider config not found: ${providerConfigPath}`);
  }

  mkdirSync(dirname(relayerConfigPath), { recursive: true });
  mkdirSync(dirname(networksOutPath), { recursive: true });
  mkdirSync(dirname(keystorePath), { recursive: true });

  if (!existsSync(keystorePath)) {
    await generateRelayerKeystore(keystorePath, passphrase);
  } else {
    console.log(`Keeping existing relayer keystore: ${keystorePath}`);
  }
  const signerAddress = readRelayerSignerAddress(keystorePath, passphrase);
  console.log(`Relayer signer address: ${signerAddress}`);

  const ozConfigDir = resolve("config/oz-relayer");
  if (!inside(ozConfigDir, keystorePath)) {
    throw new Error(`OZ_RELAYER_KEYSTORE_PATH must be under ${ozConfigDir}`);
  }

  const keyPathInContainer = `./config/${relative(ozConfigDir, keystorePath).replaceAll(sep, "/")}`;
  const relayerConfig: OzRelayerConfig = {
    relayers: [],
    notifications: [],
    signers: [
      {
        id: signerId,
        type: "local",
        config: {
          path: keyPathInContainer,
          passphrase: { type: "env", value: "OZ_KEYSTORE_PASSPHRASE" },
        },
      },
    ],
    networks: "/app/config/networks",
    plugins: [],
  };
  writeFileSync(relayerConfigPath, `${JSON.stringify(relayerConfig, null, 2)}\n`, "utf8");

  const generator = spawnSync(
    tsxBin,
    [resolve(repoRoot, "scripts/generate-oz-relayer-networks.ts"), providerConfigPath, "--update-config"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OZ_RELAYER_CONFIG_PATH: relayerConfigPath,
        OZ_EVM_NETWORKS_OUT: networksOutPath,
        OZ_RELAYER_SIGNER_ID: signerId,
      },
    },
  );
  if (generator.status !== 0) {
    throw new Error("Failed to generate OpenZeppelin Relayer networks/config");
  }

  console.log(`Prepared production relayer config: ${relayerConfigPath}`);
  console.log(`Relayer keystore: ${keystorePath}`);
  console.log("Fund the relayer signer with native gas on every enabled provider-config chain before starting prod.");
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
