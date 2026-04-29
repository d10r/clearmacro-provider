import { config as dotenvConfig } from "dotenv";

dotenvConfig();

function requireString(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid boolean env var ${name}: ${value}`);
}

function parseInteger(name: string, fallback: number, min = 0): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid integer env var ${name}: ${value}`);
  }
  return parsed;
}

export type AppEnv = ReturnType<typeof loadEnv>;

export function loadEnv() {
  return {
    databasePath: requireString("DATABASE_PATH"),
    ozRelayerUrl: requireString("OZ_RELAYER_URL"),
    ozRelayerApiKey: requireString("OZ_RELAYER_API_KEY"),
    registryPath: process.env.REGISTRY_PATH ?? "config/registry.json",
    host: process.env.HOST ?? "0.0.0.0",
    port: parseInteger("PORT", 3000, 1),
    logLevel: (process.env.LOG_LEVEL ?? "info") as
      | "trace"
      | "debug"
      | "info"
      | "warn"
      | "error"
      | "fatal",
    runMigrationsOnStart: parseBoolean("RUN_MIGRATIONS_ON_START", true),
    relayerWorkerEnabled: parseBoolean("RELAYER_WORKER_ENABLED", true),
    relayerWorkerPollIntervalMs: parseInteger("RELAYER_WORKER_POLL_INTERVAL_MS", 2000, 1),
    relayerWorkerBatchSize: parseInteger("RELAYER_WORKER_BATCH_SIZE", 25, 1),
    apiAuthEnabled: parseBoolean("API_AUTH_ENABLED", false),
    defaultConfirmations: parseInteger("DEFAULT_CONFIRMATIONS", 1, 1),
    requestMaxMetadataKeys: parseInteger("REQUEST_MAX_METADATA_KEYS", 20, 0),
    requestMaxMetadataValueLength: parseInteger("REQUEST_MAX_METADATA_VALUE_LENGTH", 256, 1),
    relayerRequestTimeoutMs: parseInteger("RELAYER_REQUEST_TIMEOUT_MS", 10_000, 1),
  };
}

