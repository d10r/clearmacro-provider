import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let keystorePasswordFile: string | undefined;

export function getKeystorePasswordFile(): string | undefined {
  return keystorePasswordFile;
}

export function keystoreSpawnEnv(useKeystore: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (useKeystore) {
    const file = getKeystorePasswordFile();
    if (file) env.ETH_PASSWORD = file;
  }
  return env;
}

/** Prepare Foundry `--account` unlock password (KEYSTORE_PASSWORD or KEYSTORE_PASSWORD_FILE). */
export function applyKeystorePasswordEnv(): void {
  if (keystorePasswordFile) return;

  if (process.env.ETH_PASSWORD) {
    keystorePasswordFile = process.env.ETH_PASSWORD;
    delete process.env.ETH_PASSWORD;
    return;
  }

  const file = process.env.KEYSTORE_PASSWORD_FILE?.trim();
  if (file) {
    if (!existsSync(file)) {
      throw new Error(`KEYSTORE_PASSWORD_FILE not found: ${file}`);
    }
    keystorePasswordFile = file;
    return;
  }

  if (!("KEYSTORE_PASSWORD" in process.env)) return;

  const pwd = process.env.KEYSTORE_PASSWORD ?? "";
  keystorePasswordFile = join(tmpdir(), `clearmacro-ops-keystore-${process.pid}-${Date.now()}`);
  writeFileSync(keystorePasswordFile, pwd, { mode: 0o600 });

  const cleanupPath = keystorePasswordFile;
  const cleanup = (): void => {
    try {
      unlinkSync(cleanupPath);
    } catch {
      // ignore
    }
    if (keystorePasswordFile === cleanupPath) keystorePasswordFile = undefined;
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
}
