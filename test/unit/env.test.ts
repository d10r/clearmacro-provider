import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("parses required and optional values", () => {
    process.env.DATABASE_PATH = ":memory:";
    process.env.OZ_RELAYER_URL = "http://localhost:8080";
    process.env.OZ_RELAYER_API_KEY = "token";
    process.env.PORT = "3333";
    process.env.API_AUTH_ENABLED = "true";

    const env = loadEnv();
    expect(env.databasePath).toBe(":memory:");
    expect(env.port).toBe(3333);
    expect(env.apiAuthEnabled).toBe(true);
  });

  it("fails on missing required values", () => {
    delete process.env.DATABASE_PATH;
    process.env.OZ_RELAYER_URL = "http://localhost:8080";
    process.env.OZ_RELAYER_API_KEY = "token";
    expect(() => loadEnv()).toThrow("DATABASE_PATH");
  });
});

