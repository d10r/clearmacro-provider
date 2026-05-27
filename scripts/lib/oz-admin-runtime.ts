export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * Host-side ops scripts call the OZ admin API from outside Docker.
 *
 * The app container uses `OZ_RELAYER_URL` (default `http://oz-relayer:8080` in
 * compose.prod.yaml). Host admin commands use `OZ_RELAYER_ADMIN_URL` or the
 * localhost port published by compose, not the in-network app URL.
 */
export function resolveOzRelayerAdminUrl(): string {
  const explicitAdminUrl = process.env.OZ_RELAYER_ADMIN_URL?.trim();
  if (explicitAdminUrl) {
    return explicitAdminUrl;
  }

  const hostPort = process.env.OZ_RELAYER_HOST_PORT?.trim() || "8080";
  return `http://localhost:${hostPort}`;
}

export type AssertOzRelayerAdminReachableOptions = {
  composeFile?: string;
  timeoutMs?: number;
};

/**
 * Fail fast when host-side admin commands cannot reach the OZ relayer API.
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
        `Start the relayer stack first:\n` +
        `  docker compose -f ${composeFile} up -d redis oz-relayer`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
