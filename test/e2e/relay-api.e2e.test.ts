import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { clearMacroForwarderV1Abi } from "../../src/chain/clearMacroForwarderV1Abi.js";
import { processRelayerWorkerTick } from "../../src/relayer/worker.js";
import type { OzRelayerClient } from "../../src/relayer/client.js";
import { createTestHarness } from "../fixtures/harness.js";
import { buildClearMacroParams, buildPermit2RelayPayload, buildRelayPayload } from "../fixtures/relay-fixtures.js";
import { buildPermit2Context } from "../../src/chain/permit2.js";

function relayerClientFullSuccess(capture?: { submittedData?: string }): OzRelayerClient {
  const hash = `0x${"cd".repeat(32)}`;
  const tx = {
    id: "oz-e2e-1",
    hash,
    status: "confirmed",
    status_reason: null,
    created_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(),
    gas_price: "1",
    gas_limit: 21000,
    nonce: 1,
    value: "0",
    from: `0x${"aa".repeat(20)}`,
    to: `0x${"bb".repeat(20)}`,
    relayer_id: "relayer-main",
    data: "0x",
    max_fee_per_gas: null,
    max_priority_fee_per_gas: null,
    mined_at: new Date().toISOString(),
    receipt: {
      transactionHash: hash,
      blockNumber: "1",
      status: "0x1",
      gasUsed: "21000",
    },
  };
  return {
    ready: async () => true,
    listRelayerIds: async () => ["relayer-main"],
    getRelayer: async () => ({
      address: `0x${"aa".repeat(20)}`,
      paused: false,
      system_disabled: false,
      network_type: "evm",
      network: "1",
    }),
    getNetwork: async () => ({
      id: "eip155:1",
      network_type: "evm",
      required_confirmations: 1,
    }),
    submitTransaction: async (_id: string, submit: { data: string; to: string; value?: string }) => {
      if (capture) {
        capture.submittedData = submit.data;
      }
      return {
        id: "oz-e2e-1",
        hash,
        status: "submitted",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        confirmed_at: null,
        gas_price: "1",
        gas_limit: 21000,
        nonce: 1,
        value: submit.value ?? "0",
        from: `0x${"aa".repeat(20)}`,
        to: submit.to,
        relayer_id: "relayer-main",
        data: submit.data,
        max_fee_per_gas: null,
        max_priority_fee_per_gas: null,
        mined_at: null,
        receipt: null,
      };
    },
    getTransaction: async () => tx,
  } as unknown as OzRelayerClient;
}

describe("E2E relay API", () => {
  it("exposes health, capabilities, readyz, and prometheus metrics", async () => {
    const { app } = await createTestHarness();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });

    const cap = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(cap.statusCode).toBe(200);
    const capBody = cap.json<{
      providerName: string;
      chains: Array<{
        chainId: number;
        forwarderAddress: string;
        macroPolicy: { mode: string; allowedMacros?: unknown[] };
      }>;
    }>();
    expect(capBody.providerName).toBe("macros.superfluid.eth");
    expect(capBody.chains[0]?.chainId).toBe(1);
    expect(capBody.chains[0]?.forwarderAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(capBody.chains[0]?.macroPolicy?.mode).toBe("allowlist");
    expect(capBody.chains[0]?.macroPolicy).toMatchObject({
      mode: "allowlist",
      allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
    });

    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json<{ ready: boolean; chains: unknown[] }>().ready).toBe(true);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.payload).toContain("clearmacro_requests_total");
  });

  it("journey: POST create → GET → response matches capabilities forwarder", async () => {
    const { app } = await createTestHarness();
    const cap = await app.inject({ method: "GET", url: "/v1/capabilities" });
    const forwarder = cap.json<{ chains: Array<{ forwarderAddress: string }> }>().chains[0]!.forwarderAddress;

    const payload = await buildRelayPayload();
    const post = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(post.statusCode).toBe(202);
    const row = post.json<{ id: string; state: string; forwarderAddress: string; transaction?: unknown }>();
    expect(row.state).toBe("pending");
    expect(row.forwarderAddress.toLowerCase()).toBe(forwarder.toLowerCase());
    expect(row.transaction).toBeUndefined();

    const get = await app.inject({ method: "GET", url: `/v1/relay-executions/${row.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ id: string; state: string }>().id).toBe(row.id);
  });

  it("journey: digest replay returns 200 with same body", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });

  it("journey: POST → worker tick → GET terminal succeeded", async () => {
    const relayer = relayerClientFullSuccess();
    const harness = await createTestHarness({ relayerClient: relayer });
    const post = await harness.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload(),
    });
    expect(post.statusCode).toBe(202);
    const id = post.json<{ id: string }>().id;

    await processRelayerWorkerTick({
      executions: harness.executions,
      executionEvents: harness.executionEvents,
      relayerTransactions: harness.relayerTransactions,
      relayerClient: relayer,
      registry: harness.registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const final = await harness.app.inject({ method: "GET", url: `/v1/relay-executions/${id}` });
    expect(final.statusCode).toBe(200);
    const body = final.json<{ state: string; terminal: boolean; receipt?: { status: string } }>();
    expect(body.state).toBe("succeeded");
    expect(body.terminal).toBe(true);
    expect(body.receipt?.status).toBe("success");
  });

  it("journey: Permit2 POST → worker tick → runPermit2AndMacro calldata → GET terminal succeeded", async () => {
    const capture: { submittedData?: string } = {};
    const relayer = relayerClientFullSuccess(capture);
    const harness = await createTestHarness({ relayerClient: relayer });
    const post = await harness.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload(),
    });
    expect(post.statusCode).toBe(202);
    const created = post.json<{ id: string; state: string; kind: string }>();
    expect(created.state).toBe("pending");
    expect(created.kind).toBe("clearMacroPermit2V1");

    await processRelayerWorkerTick({
      executions: harness.executions,
      executionEvents: harness.executionEvents,
      relayerTransactions: harness.relayerTransactions,
      relayerClient: relayer,
      registry: harness.registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "ok",
      resolvePermit2Context: async ({ permit2, owner }) =>
        buildPermit2Context({
          permit2,
          owner,
          witness: `0x${"22".repeat(32)}`,
          witnessTypeString: "witness-type",
        }),
    });

    expect(capture.submittedData).toBeDefined();
    const decoded = decodeFunctionData({
      abi: clearMacroForwarderV1Abi,
      data: capture.submittedData as `0x${string}`,
    });
    expect(decoded.functionName).toBe("runPermit2AndMacro");

    const final = await harness.app.inject({
      method: "GET",
      url: `/v1/relay-executions/${created.id}`,
    });
    expect(final.statusCode).toBe(200);
    const body = final.json<{ state: string; terminal: boolean; receipt?: { status: string } }>();
    expect(body.state).toBe("succeeded");
    expect(body.terminal).toBe(true);
    expect(body.receipt?.status).toBe("success");
  });

  it("rejects unknown chain before persistence", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload({ chainId: 999 });
    const res = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("CHAIN_NOT_ALLOWED");
  });

  it("rejects macro not allowlisted by domain", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload({
      payload: buildClearMacroParams({ domain: "not.allowlisted" }) as `0x${string}`,
    });
    const res = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("MACRO_NOT_ALLOWED");
  });

  it("rejects provider name mismatch", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload({
      payload: buildClearMacroParams({ provider: "wrong.provider" }) as `0x${string}`,
    });
    const res = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("PROVIDER_NOT_ALLOWED");
  });

  it("returns 404 for unknown execution id", async () => {
    const { app } = await createTestHarness();
    const res = await app.inject({ method: "GET", url: "/v1/relay-executions/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("readyz returns 503 when a chain is not ready", async () => {
    const { app } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "RELAYER_UNAVAILABLE" }),
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ ready: boolean }>().ready).toBe(false);
  });

  it("GET execution supports include=events", async () => {
    const { app } = await createTestHarness();
    const post = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload(),
    });
    const id = post.json<{ id: string }>().id;
    const res = await app.inject({ method: "GET", url: `/v1/relay-executions/${id}?include=events` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events?: Array<{ type: string }> }>();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events!.length).toBeGreaterThan(0);
  });

  it("authenticated happy path with bearer token", async () => {
    const token = "e2e-secret-token";
    const hash = createHash("sha256").update(token).digest("hex").toLowerCase();
    const { app } = await createTestHarness({
      env: { apiAuthEnabled: true, apiClients: [{ id: "e2e-client", apiTokenHash: hash }] },
    });
    const payload = await buildRelayPayload();
    const res = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);
  });
});
