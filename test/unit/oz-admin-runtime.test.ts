import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOzRelayerAdminReachable,
  requireEnv,
  resolveOzRelayerAdminUrl,
} from "../../scripts/lib/oz-admin-runtime.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("requireEnv", () => {
  it("throws when env var is missing or blank", () => {
    delete process.env.OZ_RELAYER_API_KEY;
    expect(() => requireEnv("OZ_RELAYER_API_KEY")).toThrow(/Missing required env var: OZ_RELAYER_API_KEY/);

    process.env.OZ_RELAYER_API_KEY = "   ";
    expect(() => requireEnv("OZ_RELAYER_API_KEY")).toThrow(/Missing required env var: OZ_RELAYER_API_KEY/);
  });
});

describe("resolveOzRelayerAdminUrl", () => {
  it("prefers explicit host-side admin URL", () => {
    process.env.OZ_RELAYER_ADMIN_URL = "http://admin-host:8080";
    process.env.OZ_RELAYER_URL = "http://oz-relayer:8080";

    expect(resolveOzRelayerAdminUrl()).toBe("http://admin-host:8080");
  });

  it("ignores OZ_RELAYER_URL and defaults to localhost host port", () => {
    delete process.env.OZ_RELAYER_ADMIN_URL;
    process.env.OZ_RELAYER_URL = "http://oz-relayer:8080";
    process.env.OZ_RELAYER_HOST_PORT = "18080";

    expect(resolveOzRelayerAdminUrl()).toBe("http://localhost:18080");
  });

  it("defaults to localhost:8080 when no admin URL is set", () => {
    delete process.env.OZ_RELAYER_ADMIN_URL;
    delete process.env.OZ_RELAYER_URL;
    delete process.env.OZ_RELAYER_HOST_PORT;

    expect(resolveOzRelayerAdminUrl()).toBe("http://localhost:8080");
  });
});

describe("assertOzRelayerAdminReachable", () => {
  it("passes when /api/v1/ready succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true })),
    );

    await expect(assertOzRelayerAdminReachable("http://localhost:8080")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/api/v1/ready", expect.any(Object));
  });

  it("throws with compose start instructions when the admin API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );

    await expect(assertOzRelayerAdminReachable("http://localhost:8080")).rejects.toThrow(
      /docker compose -f compose\.prod\.yaml up -d redis oz-relayer/,
    );
  });
});
