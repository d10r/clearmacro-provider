import { describe, expect, it } from "vitest";
import { createTestHarness } from "../fixtures/harness.js";
import { buildClearMacroParams, buildRelayPayload } from "../fixtures/relay-fixtures.js";

describe("API integration", () => {
  it("accepts valid relay execution and returns execution resource", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload,
      headers: { "idempotency-key": "test-key" },
    });
    expect(accepted.statusCode).toBe(202);
    const acceptedBody = accepted.json<{ id: string; state: string }>();
    expect(acceptedBody.state).toBe("accepted");
    const status = await app.inject({ method: "GET", url: `/v1/relay-executions/${acceptedBody.id}` });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json<{ id: string; state: string; transaction: { hashes: string[] } }>();
    expect(statusBody.id).toBe(acceptedBody.id);
    expect(statusBody.state).toBe("accepted");
    expect(statusBody.transaction.hashes).toEqual([]);
  });

  it("returns idempotent replay and conflict", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload,
      headers: { "idempotency-key": "same-key" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload,
      headers: { "idempotency-key": "same-key" },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: { ...payload, clientRequestId: "different" },
      headers: { "idempotency-key": "same-key" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string; executionId: string | null } }>().error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.json<{ error: { executionId: string | null } }>().error.executionId).toBe(first.json<{ id: string }>().id);
  });

  it("rejects invalid signature", async () => {
    const { app } = await createTestHarness({ validateRelaySignature: async () => false });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
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
      url: "/v1/relay-executions",
      payload,
      headers: { "idempotency-key": "sticky-key" },
    });
    expect(first.statusCode).toBe(202);
    ready = false;
    const replay = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload,
      headers: { "idempotency-key": "sticky-key" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
  });

  it("maps schema and malformed body failures to 400 validation error", async () => {
    const { app } = await createTestHarness();
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
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
      url: "/v1/relay-executions",
      payload: { ...payload, metadata: { a: "1", b: "2" } },
    });
    expect(tooManyKeys.statusCode).toBe(400);
    expect(tooManyKeys.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

    const tooLongValue = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
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
      payload: buildClearMacroParams({ nonce: 1n }) as `0x${string}`,
    });
    const accepted = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: first });
    expect(accepted.statusCode).toBe(202);
    const duplicate = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: second });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe("DUPLICATE_EXECUTION");
  });

  it("accepts ERC-1271 signer path when signature validator allows it", async () => {
    const { app } = await createTestHarness({
      validateRelaySignature: async ({ signer }) => signer === "0x00000000000000000000000000000000000000aa",
    });
    const payload = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000aa",
      signature: "0x123456",
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(202);
  });

  it("maps digest RPC failures to 503 chain unavailable", async () => {
    const { app } = await createTestHarness({
      getForwarderDigest: async () => {
        throw new Error("RPC down");
      },
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
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
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("returns events when include=events is requested", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const create = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const id = create.json<{ id: string }>().id;
    const response = await app.inject({ method: "GET", url: `/v1/relay-executions/${id}?include=events` });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json<{ events?: unknown[] }>().events)).toBe(true);
  });

  it("returns 404 for missing execution id", async () => {
    const { app } = await createTestHarness();
    const response = await app.inject({ method: "GET", url: "/v1/relay-executions/missing-id" });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("EXECUTION_NOT_FOUND");
  });

  it("returns dapp-oriented capabilities shape", async () => {
    const { app } = await createTestHarness();
    const response = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ relayApi: { endpoint: string; supportsIdempotencyKey: boolean }; chains: Array<{ forwarders: { clearMacroV1: string } }> }>();
    expect(body.relayApi.endpoint).toBe("/v1/relay-executions");
    expect(body.relayApi.supportsIdempotencyKey).toBe(true);
    expect(body.chains[0]?.forwarders.clearMacroV1).toBeDefined();
  });

  it("enforces auth token when auth is enabled", async () => {
    const { app } = await createTestHarness({ apiAuthEnabled: true });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("returns 422 for not-yet-valid payload", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload({
      payload: buildClearMacroParams({ validAfter: BigInt(Math.floor(Date.now() / 1000) + 3600) }) as `0x${string}`,
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CLEAR_MACRO_NOT_YET_VALID");
  });

  it("returns 422 for expired payload", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload({
      payload: buildClearMacroParams({ validBefore: BigInt(Math.floor(Date.now() / 1000) - 1) }) as `0x${string}`,
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CLEAR_MACRO_EXPIRED");
  });

  it("normalizes address case for idempotency hash", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...payload,
        macroAddress: `0x${payload.macroAddress.slice(2).toUpperCase()}`,
        signerAddress: `0x${payload.signerAddress.slice(2).toUpperCase()}`,
      },
      headers: { "idempotency-key": "canon-key" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload,
      headers: { "idempotency-key": "canon-key" },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });
});
