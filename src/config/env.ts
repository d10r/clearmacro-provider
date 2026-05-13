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

export type ApiClientRecord = { id: string; apiTokenHash: string };

function parseApiClientsJson(): ApiClientRecord[] {
  const raw = process.env.API_CLIENTS_JSON;
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid JSON in API_CLIENTS_JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("API_CLIENTS_JSON must be a non-empty JSON array when provided");
  }
  const out: ApiClientRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      throw new Error("API_CLIENTS_JSON entries must be objects");
    }
    const id = (entry as { id?: unknown }).id;
    const apiTokenHash = (entry as { apiTokenHash?: unknown }).apiTokenHash;
    if (typeof id !== "string" || id.length === 0 || typeof apiTokenHash !== "string" || apiTokenHash.length === 0) {
      throw new Error("API_CLIENTS_JSON entries require string id and apiTokenHash");
    }
    out.push({ id, apiTokenHash: apiTokenHash.toLowerCase() });
  }
  return out;
}

export type AppEnv = ReturnType<typeof loadEnv>;

export function loadEnv() {
  const apiAuthEnabled = parseBoolean("API_AUTH_ENABLED", false);
  const apiClients = apiAuthEnabled ? parseApiClientsJson() : [];
  if (apiAuthEnabled && apiClients.length === 0) {
    throw new Error("API_AUTH_ENABLED requires non-empty API_CLIENTS_JSON");
  }
  const providerConfigPath = process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json";
  return {
    databasePath: requireString("DATABASE_PATH"),
    ozRelayerUrl: requireString("OZ_RELAYER_URL"),
    ozRelayerApiKey: requireString("OZ_RELAYER_API_KEY"),
    registryPath: providerConfigPath,
    providerName: requireString("PROVIDER_NAME"),
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
    apiAuthEnabled,
    apiClients,
    requestMaxMetadataKeys: parseInteger("REQUEST_MAX_METADATA_KEYS", 20, 0),
    requestMaxMetadataValueLength: parseInteger("REQUEST_MAX_METADATA_VALUE_LENGTH", 256, 1),
    relayerRequestTimeoutMs: parseInteger("RELAYER_REQUEST_TIMEOUT_MS", 10_000, 1),
    /** TTL for caching a successful per-chain readiness snapshot used only by `GET /readyz` (0 disables that cache). */
    readinessCacheSuccessTtlMs: parseInteger("READINESS_CACHE_SUCCESS_TTL_MS", 5000, 0),
    /** TTL for caching `RELAYER_RATE_LIMITED` readiness from `GET /readyz` (0 disables). */
    readinessCacheRateLimitedTtlMs: parseInteger("READINESS_CACHE_RATE_LIMITED_TTL_MS", 1500, 0),
    readinessOzRetryMaxAttempts: parseInteger("READINESS_OZ_RETRY_MAX_ATTEMPTS", 3, 1),
    readinessOzRetryBaseDelayMs: parseInteger("READINESS_OZ_RETRY_BASE_DELAY_MS", 100, 1),
  };
}

