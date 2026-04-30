import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.OZ_RELAYER_URL;
  delete process.env.OZ_RELAYER_API_KEY;
  delete process.env.PROVIDER_NAME;
  delete process.env.PORT;
  delete process.env.API_AUTH_ENABLED;
  delete process.env.API_CLIENTS_JSON;
});

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
  });

  it("fails on missing required values", () => {
    delete process.env.DATABASE_PATH;
    process.env.OZ_RELAYER_URL = "http://localhost:8080";
    process.env.OZ_RELAYER_API_KEY = "token";
    process.env.PROVIDER_NAME = "macros.superfluid.eth";
    process.env.API_AUTH_ENABLED = "false";
    expect(() => loadEnv()).toThrow("DATABASE_PATH");
  });
});

