import { describe, expect, it } from "vitest";
import { createTestHarness } from "../fixtures/harness.js";
import { metricSampleValue } from "../fixtures/metrics.js";
import { buildRelayPayload } from "../fixtures/relay-fixtures.js";

const ACTIONABLE = "clearmacro_actionable_failures_total";

describe("actionable failure metrics — admission", () => {
  it("increments PROVIDER_NOT_READY on readiness failure", async () => {
    const { app, metrics } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(503);

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "admission",
        code: "PROVIDER_NOT_READY",
      }),
    ).toBe(1);

    const httpMetrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(httpMetrics.statusCode).toBe(200);
    expect(
      metricSampleValue(httpMetrics.body, ACTIONABLE, {
        chain_id: "1",
        stage: "admission",
        code: "PROVIDER_NOT_READY",
      }),
    ).toBe(1);
  });

  it("increments CHAIN_UNAVAILABLE when digest RPC fails", async () => {
    const { app, metrics } = await createTestHarness({
      getForwarderDigest: async () => {
        throw new Error("rpc down");
      },
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "admission",
        code: "CHAIN_UNAVAILABLE",
      }),
    ).toBe(1);
  });

  it("does not increment actionable counter for invalid signature", async () => {
    const { app, metrics } = await createTestHarness({
      validateRelaySignature: async () => false,
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);

    const text = await metrics.registry.metrics();
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });

  it("does not increment actionable counter for preflight revert", async () => {
    const { app, metrics } = await createTestHarness({
      preflightRunMacro: async () => "deterministic_revert",
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);

    const text = await metrics.registry.metrics();
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });

  it("increments RELAYER_RATE_LIMITED on admission (metered, catch-all excludes)", async () => {
    const { app, metrics } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "RELAYER_RATE_LIMITED" }),
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(503);

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "admission",
        code: "RELAYER_RATE_LIMITED",
      }),
    ).toBe(1);
  });

  it("does not increment actionable counter on successful create", async () => {
    const { app, metrics } = await createTestHarness();
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(202);

    const text = await metrics.registry.metrics();
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });
});
