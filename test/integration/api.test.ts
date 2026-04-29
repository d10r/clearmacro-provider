import { describe, expect, it } from "vitest";
import { createTestHarness } from "../fixtures/harness.js";
import { buildClearMacroParams, buildRelayPayload } from "../fixtures/relay-fixtures.js";

describe("API integration", () => {
  it("accepts valid relay request and returns status", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload,
      headers: { "idempotency-key": "test-key" },
    });
    expect(accepted.statusCode).toBe(202);
    const acceptedBody = accepted.json<{ requestId: string }>();
    const status = await app.inject({ method: "GET", url: `/v1/requests/${acceptedBody.requestId}` });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json<{ request: { state: string }; relayerTransaction?: unknown }>();
    expect(statusBody.request.state).toBe("accepted");
    expect(statusBody.relayerTransaction).toBeUndefined();
  });

  it("returns idempotent replay and conflict", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload,
      headers: { "idempotency-key": "same-key" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload,
      headers: { "idempotency-key": "same-key" },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json<{ requestId: string }>().requestId).toBe(second.json<{ requestId: string }>().requestId);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload: { ...payload, clientRequestId: "different" },
      headers: { "idempotency-key": "same-key" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("rejects invalid signature", async () => {
    const { app } = await createTestHarness({ validateRelaySignature: async () => false });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay", payload });
    expect(response.statusCode).toBe(422);
  });

  it("returns 503 readiness when any enabled chain is not ready", async () => {
    const { app } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(503);
    expect(readyz.json<{ ready: boolean }>().ready).toBe(false);
  });

  it("surfaces confirmation mismatch readiness reason", async () => {
    const { app } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "CONFIRMATION_MISMATCH" }),
    });
    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(503);
    expect(readyz.json<{ chains: Array<{ reasonCode: string | null }> }>().chains[0]?.reasonCode).toBe("CONFIRMATION_MISMATCH");
  });

  it("returns idempotent replay even when chain later becomes unready", async () => {
    let ready = true;
    const { app } = await createTestHarness({
      getChainReadiness: async () => (ready ? { ready: true } : { ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const payload = await buildRelayPayload();
    const first = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload,
      headers: { "idempotency-key": "sticky-key" },
    });
    expect(first.statusCode).toBe(202);
    ready = false;
    const replay = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload,
      headers: { "idempotency-key": "sticky-key" },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json<{ requestId: string }>().requestId).toBe(first.json<{ requestId: string }>().requestId);
  });

  it("maps schema and malformed body failures to 400 validation error", async () => {
    const { app } = await createTestHarness();
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/relay",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload: { kind: "clearMacroV1", chainId: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("maps metadata guard failures to 400 validation error", async () => {
    const { app } = await createTestHarness({ requestMaxMetadataKeys: 1, requestMaxMetadataValueLength: 2 });
    const payload = await buildRelayPayload();
    const tooManyKeys = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload: { ...payload, metadata: { a: "1", b: "2" } },
    });
    expect(tooManyKeys.statusCode).toBe(400);
    expect(tooManyKeys.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

    const tooLongValue = await app.inject({
      method: "POST",
      url: "/v1/relay",
      payload: { ...payload, metadata: { a: "123" } },
    });
    expect(tooLongValue.statusCode).toBe(400);
    expect(tooLongValue.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 409 duplicate request for semantic uniqueness conflict", async () => {
    const { app } = await createTestHarness();
    const first = await buildRelayPayload();
    const second = await buildRelayPayload({
      signature: "0x1234",
      params: buildClearMacroParams({ nonce: 1n }) as `0x${string}`,
    });
    const accepted = await app.inject({ method: "POST", url: "/v1/relay", payload: first });
    expect(accepted.statusCode).toBe(202);
    const duplicate = await app.inject({ method: "POST", url: "/v1/relay", payload: second });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe("DUPLICATE_REQUEST");
  });

  it("accepts ERC-1271 signer path when signature validator allows it", async () => {
    const { app } = await createTestHarness({
      validateRelaySignature: async ({ signer }) => signer === "0x00000000000000000000000000000000000000aa",
    });
    const payload = await buildRelayPayload({
      signer: "0x00000000000000000000000000000000000000aa",
      signature: "0x123456",
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay", payload });
    expect(response.statusCode).toBe(202);
  });

  it("maps digest RPC failures to 503 chain unavailable", async () => {
    const { app } = await createTestHarness({
      getForwarderDigest: async () => {
        throw new Error("RPC down");
      },
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay", payload });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("maps signature validation RPC failures to 503 chain unavailable", async () => {
    const { app } = await createTestHarness({
      validateRelaySignature: async () => {
        throw new Error("RPC down");
      },
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay", payload });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });
});
