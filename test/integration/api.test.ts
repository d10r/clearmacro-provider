import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReadyzReadinessCache } from "../../src/chain/readinessCache.js";
import { createTestHarness } from "../fixtures/harness.js";
import { buildClearMacroParams, buildRelayPayload } from "../fixtures/relay-fixtures.js";

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("API integration", () => {
  it("accepts valid relay execution and returns pending execution resource", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const created = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(created.statusCode).toBe(202);
    const createdBody = created.json<{ id: string; state: string; transaction?: { hash: string } }>();
    expect(createdBody.state).toBe("pending");
    expect(createdBody.transaction).toBeUndefined();
    const status = await app.inject({ method: "GET", url: `/v1/relay-executions/${createdBody.id}` });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json<{ id: string; state: string; transaction?: unknown }>();
    expect(statusBody.id).toBe(createdBody.id);
    expect(statusBody.state).toBe("pending");
  });

  it("replays identical signed intent with 200 for same anonymous caller", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });

  it("returns 409 DUPLICATE_EXECUTION without leaking id across authenticated clients", async () => {
    const tokA = "token-a";
    const tokB = "token-b";
    const app = (
      await createTestHarness({
        env: {
          apiAuthEnabled: true,
          apiClients: [
            { id: "client-a", apiTokenHash: createHash("sha256").update(tokA).digest("hex").toLowerCase() },
            { id: "client-b", apiTokenHash: createHash("sha256").update(tokB).digest("hex").toLowerCase() },
          ],
        },
      })
    ).app;
    const payload = await buildRelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokA) });
    expect(first.statusCode).toBe(202);
    const dup = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokB) });
    expect(dup.statusCode).toBe(409);
    const err = dup.json<{ error: { code: string; executionId: string | null } }>().error;
    expect(err.code).toBe("DUPLICATE_EXECUTION");
    expect(err.executionId).toBeNull();
  });

  it("allows different payloads that share a nonce when digests differ", async () => {
    const { app } = await createTestHarness({
      getForwarderDigest: async (input) =>
        `0x${createHash("sha256").update(input.encodedPayload).digest("hex")}`,
    });
    const first = await buildRelayPayload();
    const second = await buildRelayPayload({
      signature: "0x1234",
      payload: buildClearMacroParams({ nonce: 1n, actionParams: "0x9999" }) as `0x${string}`,
    });
    const a = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: first });
    const b = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: second });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });

  it("rejects invalid signature", async () => {
    const { app } = await createTestHarness({ validateRelaySignature: async () => false });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
  });

  it("returns 503 readiness when any chain is not ready", async () => {
    const { app } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(503);
    expect(readyz.json<{ ready: boolean }>().ready).toBe(false);
  });

  it("GET /readyz uses cached readiness while POST uses uncached readiness", async () => {
    let readyzInnerCalls = 0;
    let relayReadinessCalls = 0;
    const inner = async (_chainId: number) => {
      readyzInnerCalls += 1;
      return { ready: true as const };
    };
    const cached = createReadyzReadinessCache(inner, { successTtlMs: 60_000, rateLimitedTtlMs: 1000 });
    const { app } = await createTestHarness({
      getReadyzChainReadiness: cached,
      getChainReadiness: async () => {
        relayReadinessCalls += 1;
        return { ready: true };
      },
    });
    await app.inject({ method: "GET", url: "/readyz" });
    await app.inject({ method: "GET", url: "/readyz" });
    const payload = await buildRelayPayload();
    await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(readyzInnerCalls).toBe(1);
    expect(relayReadinessCalls).toBeGreaterThanOrEqual(1);
  });

  it("returns 503 RELAYER_RATE_LIMITED with relayer category when readiness reports rate limit", async () => {
    const { app } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "RELAYER_RATE_LIMITED" }),
    });
    const payload = await buildRelayPayload();
    const res = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(res.statusCode).toBe(503);
    const err = res.json<{ error: { code: string; category: string } }>().error;
    expect(err.code).toBe("RELAYER_RATE_LIMITED");
    expect(err.category).toBe("relayer");
  });

  it("returns 422 when preflight reverts and force is false", async () => {
    const { app } = await createTestHarness({
      preflightRunMacro: async () => "deterministic_revert",
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("PREFLIGHT_REVERTED");
  });

  it("returns 202 pending when preflight reverts and force is true", async () => {
    const { app } = await createTestHarness({
      preflightRunMacro: async () => "deterministic_revert",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({ forceExecuteAfterPreflightRevert: true }),
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ state: string; metadata: Record<string, string> }>();
    expect(body.state).toBe("pending");
    expect(body.metadata.forceSubmittedAfterPreflightRevert).toBe("true");
  });

  it("does not bypass policy when force is true", async () => {
    const { app } = await createTestHarness({
      preflightRunMacro: async () => "deterministic_revert",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...(await buildRelayPayload({ payload: buildClearMacroParams({ provider: "wrong.provider.eth" }) as `0x${string}` })),
        forceExecuteAfterPreflightRevert: true,
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("open mode accepts macro not present in allowlist", async () => {
    const { app } = await createTestHarness({ macroPolicyMode: "open" });
    const macroAddress = "0x0000000000000000000000000000000000000003" as const;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress,
        payload: buildClearMacroParams({ domain: "any.domain", macroContract: macroAddress }) as `0x${string}`,
      }),
    });
    expect(response.statusCode).toBe(202);
  });

  it("open mode still rejects macro mismatch between request and payload", async () => {
    const { app } = await createTestHarness({ macroPolicyMode: "open" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress: "0x0000000000000000000000000000000000000003",
        payload: buildClearMacroParams({
          domain: "any.domain",
          macroContract: "0x0000000000000000000000000000000000000002",
        }) as `0x${string}`,
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_CLEAR_MACRO_PAYLOAD");
  });

  it("open mode still rejects provider mismatch and invalid signature", async () => {
    const providerMismatch = await createTestHarness({ macroPolicyMode: "open" });
    const providerResponse = await providerMismatch.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress: "0x0000000000000000000000000000000000000003",
        payload: buildClearMacroParams({
          domain: "any.domain",
          provider: "wrong.provider.eth",
          macroContract: "0x0000000000000000000000000000000000000003",
        }) as `0x${string}`,
      }),
    });
    expect(providerResponse.statusCode).toBe(403);
    expect(providerResponse.json<{ error: { code: string } }>().error.code).toBe("PROVIDER_NOT_ALLOWED");

    const signatureInvalid = await createTestHarness({ macroPolicyMode: "open", validateRelaySignature: async () => false });
    const signatureResponse = await signatureInvalid.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress: "0x0000000000000000000000000000000000000003",
        payload: buildClearMacroParams({
          domain: "any.domain",
          macroContract: "0x0000000000000000000000000000000000000003",
        }) as `0x${string}`,
      }),
    });
    expect(signatureResponse.statusCode).toBe(422);
    expect(signatureResponse.json<{ error: { code: string } }>().error.code).toBe("SIGNATURE_INVALID");
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

  it("returns capabilities for dapps", async () => {
    const { app } = await createTestHarness();
    const response = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      providerName: string;
      chains: Array<{
        chainId: number;
        forwarderAddress: string;
        macroPolicy: { mode: "allowlist"; allowedMacros: Array<{ domain: string; address: string }> };
      }>;
    }>();
    expect(body.providerName).toBe("macros.superfluid.eth");
    expect(body.chains[0]?.chainId).toBe(1);
    expect(body.chains[0]?.forwarderAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(body.chains[0]?.macroPolicy).toEqual({
      mode: "allowlist",
      allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
    });
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

  it("canonicalizes addresses into digest dedup key", async () => {
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
    });
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });

  it("records audit rows for failed creates", async () => {
    const { app, db } = await createTestHarness({ validateRelaySignature: async () => false });
    const payload = await buildRelayPayload();
    await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const row = db.db.prepare("SELECT outcome_code FROM create_request_audit_log ORDER BY created_at DESC LIMIT 1").get() as {
      outcome_code: string;
    };
    expect(row.outcome_code).toBe("SIGNATURE_INVALID");
  });
});
