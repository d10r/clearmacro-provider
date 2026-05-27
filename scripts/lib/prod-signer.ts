import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Keystore } from "ox";
import { privateKeyToAccount, type Address } from "viem/accounts";
import type { Registry } from "../../src/config/schema.js";

export function resolveProdPaths(): {
  providerConfigPath: string;
  keystorePath: string;
  ozConfigDir: string;
} {
  const providerConfigPath = resolve(process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json");
  const ozConfigDir = resolve("config/oz-relayer");
  const keystorePath = resolve(process.env.OZ_RELAYER_KEYSTORE_PATH ?? "config/oz-relayer/keys/prod-relayer.json");
  return { providerConfigPath, keystorePath, ozConfigDir };
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadProviderConfig(path: string): Registry {
  if (!existsSync(path)) {
    throw new Error(`Missing provider config: ${path}`);
  }
  return readJson(path) as Registry;
}

export function readRelayerSignerAddress(keystorePath: string, passphrase: string): Address {
  const keystore = readJson(keystorePath) as Parameters<typeof Keystore.toKey>[0];
  const key = Keystore.toKey(keystore, { password: passphrase });
  const privateKey = Keystore.decrypt(keystore, key);
  return privateKeyToAccount(privateKey).address;
}

export function assertKeystoreUnderOzConfig(keystorePath: string, ozConfigDir: string): void {
  const rel = relative(ozConfigDir, keystorePath);
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error(`OZ_RELAYER_KEYSTORE_PATH must be under ${ozConfigDir}`);
  }
}

/** Human-readable ETH; keeps enough decimals that sub-milli-ETH targets are not shown as 0. */
export function formatEthFromWei(wei: bigint): string {
  const sign = wei < 0n ? "-" : "";
  const abs = wei < 0n ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  if (whole === 0n && frac > 0n && frac < 10n ** 14n) {
    const digits = frac.toString().padStart(18, "0").replace(/0+$/, "");
    return `${sign}0.${digits}`;
  }
  const frac4 = frac / 10n ** 14n;
  return `${sign}${whole}.${frac4.toString().padStart(4, "0")}`;
}
