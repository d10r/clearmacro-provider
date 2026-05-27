export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const DEFAULT_IN_NETWORK_ADMIN_URL = "http://oz-relayer:8080";

/**
 * URL for OpenZeppelin Relayer admin API calls from prod admin scripts.
 *
 * Production: run via `pnpm run prod:apply-config` / `prod:check-config`, which execute
 * the Compose `admin` job with `OZ_RELAYER_ADMIN_URL=http://oz-relayer:8080`.
 *
 * The app runtime uses `OZ_RELAYER_URL` (same in-network default in compose.prod.yaml).
 */
export function resolveOzRelayerAdminUrl(): string {
  const explicitAdminUrl = process.env.OZ_RELAYER_ADMIN_URL?.trim();
  if (explicitAdminUrl) {
    return explicitAdminUrl;
  }

  return DEFAULT_IN_NETWORK_ADMIN_URL;
}

export type AssertOzRelayerAdminReachableOptions = {
  composeFile?: string;
  timeoutMs?: number;
};

/**
 * Fail fast when admin commands cannot reach the OZ relayer API.
 */
export async function assertOzRelayerAdminReachable(
  adminUrl: string,
  opts: AssertOzRelayerAdminReachableOptions = {},
): Promise<void> {
  const composeFile = opts.composeFile ?? process.env.COMPOSE_PROD_FILE ?? "compose.prod.yaml";
  const timeoutMs = opts.timeoutMs ?? 5000;
  const readyUrl = `${adminUrl.replace(/\/$/, "")}/api/v1/ready`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(readyUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach OpenZeppelin Relayer admin API at ${adminUrl}: ${detail}\n` +
        `Ensure redis and oz-relayer are running, then retry:\n` +
        `  docker compose -f ${composeFile} up -d redis oz-relayer\n` +
        `  pnpm run prod:apply-config`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
