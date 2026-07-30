import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

beforeEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.OZ_RELAYER_URL;
  delete process.env.OZ_RELAYER_API_KEY;
  delete process.env.PROVIDER_NAME;
  delete process.env.PORT;
  delete process.env.API_AUTH_ENABLED;
  delete process.env.API_CLIENTS_JSON;
  delete process.env.RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS;
  delete process.env.SAFE_API_KEY;
  delete process.env.SAFE_AUTHORIZATION_ENABLED;
});

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.OZ_RELAYER_URL;
  delete process.env.OZ_RELAYER_API_KEY;
  delete process.env.PROVIDER_NAME;
  delete process.env.PORT;
  delete process.env.API_AUTH_ENABLED;
  delete process.env.API_CLIENTS_JSON;
  delete process.env.RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS;
  delete process.env.SAFE_API_KEY;
  delete process.env.SAFE_AUTHORIZATION_ENABLED;
});

function setRequiredEnv(): void {
  process.env.OZ_RELAYER_URL = "http://localhost:8080";
  process.env.OZ_RELAYER_API_KEY = "token";
  process.env.PROVIDER_NAME = "macros.superfluid.eth";
  process.env.API_AUTH_ENABLED = "false";
}

describe("loadEnv", () => {
  it("parses required and optional values", () => {
    process.env.DATABASE_PATH = ":memory:";
    process.env.OZ_RELAYER_URL = "http://localhost:8080";
    process.env.OZ_RELAYER_API_KEY = "token";
    process.env.PROVIDER_NAME = "macros.superfluid.eth";
    process.env.PORT = "3333";
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_CLIENTS_JSON = JSON.stringify([{ id: "test", apiTokenHash: "abcd" }]);

    const env = loadEnv();
    expect(env.databasePath).toBe(":memory:");
    expect(env.port).toBe(3333);
    expect(env.apiAuthEnabled).toBe(true);
    expect(env.providerName).toBe("macros.superfluid.eth");
    expect(env.relayerSignerBalanceSampleIntervalMs).toBe(60 * 60 * 1000);
    expect(env.safeAuthorizationEnabled).toBe(false);
    expect(env.safeApiKey).toBeNull();
  });

  it("parses relayer signer balance sample interval", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS = "0";
    expect(loadEnv().relayerSignerBalanceSampleIntervalMs).toBe(0);
  });

  it("defaults database path when unset", () => {
    delete process.env.DATABASE_PATH;
    setRequiredEnv();
    expect(loadEnv().databasePath).toBe("./data/clearmacro-provider-dev.sqlite");
  });

  it("fails on missing required values", () => {
    process.env.DATABASE_PATH = ":memory:";
    delete process.env.OZ_RELAYER_URL;
    process.env.OZ_RELAYER_API_KEY = "token";
    process.env.PROVIDER_NAME = "macros.superfluid.eth";
    process.env.API_AUTH_ENABLED = "false";
    expect(() => loadEnv()).toThrow("OZ_RELAYER_URL");
  });

  it("enables Safe authorization when SAFE_API_KEY is set", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "safe-key";
    const env = loadEnv();
    expect(env.safeAuthorizationEnabled).toBe(true);
    expect(env.safeApiKey).toBe("safe-key");
  });

  it("keeps Safe authorization off when SAFE_API_KEY is blank", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "   ";
    const env = loadEnv();
    expect(env.safeAuthorizationEnabled).toBe(false);
    expect(env.safeApiKey).toBeNull();
  });

  it("forces Safe authorization off when SAFE_AUTHORIZATION_ENABLED=false", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "safe-key";
    process.env.SAFE_AUTHORIZATION_ENABLED = "false";
    expect(loadEnv().safeAuthorizationEnabled).toBe(false);
  });

  it("rejects SAFE_AUTHORIZATION_ENABLED=true without SAFE_API_KEY", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_AUTHORIZATION_ENABLED = "true";
    expect(() => loadEnv()).toThrow("SAFE_AUTHORIZATION_ENABLED=true requires SAFE_API_KEY");
  });

  it("allows SAFE_AUTHORIZATION_ENABLED=true when SAFE_API_KEY is set", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "safe-key";
    process.env.SAFE_AUTHORIZATION_ENABLED = "true";
    expect(loadEnv().safeAuthorizationEnabled).toBe(true);
  });
});

