import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/app.js";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { AuditEventRepository, RelayRequestRepository, RelayerTransactionRepository } from "../../src/db/repositories.js";
import { loadRegistry } from "../../src/config/registry.js";
import { clearMacroPayloadAbiParameters } from "../../src/validation/clearmacro.js";

function makeParams() {
  return encodeAbiParameters(clearMacroPayloadAbiParameters, [
    {
      action: { params: "0x1234" },
      security: {
        domain: "test",
        macroContract: "0x0000000000000000000000000000000000000002",
        provider: "macros.superfluid.eth",
        validAfter: 0n,
        validBefore: 0n,
        nonce: 1n,
      },
    },
  ]);
}

async function setup(overrides?: {
  getChainReadiness?: (chainId: number) => Promise<{ ready: boolean; reasonCode?: "PROVIDER_NOT_READY" | "RELAYER_UNAVAILABLE" }>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "api-test-"));
  const registryPath = join(dir, "registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          name: "mainnet",
          enabled: true,
          ozRelayerId: "relayer-main",
          rpcs: [{ name: "rpc1", url: "http://localhost:8545" }],
          confirmations: 1,
          superfluidHost: "0x0000000000000000000000000000000000000009",
          forwarders: {
            clearMacroV1: "0x0000000000000000000000000000000000000001",
            permit2ClearMacroV1: "0x0000000000000000000000000000000000000004",
          },
          providers: ["macros.superfluid.eth"],
          macros: [
            {
              address: "0x0000000000000000000000000000000000000002",
              name: "Macro",
              enabled: true,
              supportedKinds: ["clearMacroV1"],
            },
          ],
        },
      ],
      clients: [
        {
          id: "default",
          enabled: true,
          apiTokenHash: null,
          allowedChains: [1],
          allowedProviders: ["macros.superfluid.eth"],
          allowedMacros: ["0x0000000000000000000000000000000000000002"],
        },
      ],
    }),
  );
  const registry = loadRegistry({ registryPath, defaultConfirmations: 1 });
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const requests = new RelayRequestRepository(db);
  const audits = new AuditEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const built = await createApp({
    registry,
    requests,
    audits,
    relayerTransactions,
    apiAuthEnabled: false,
    requestMaxMetadataKeys: 20,
    requestMaxMetadataValueLength: 256,
    logLevel: "error",
    getChainReadiness: overrides?.getChainReadiness ?? (async () => ({ ready: true })),
    getForwarderDigest: async () => "0x" + "11".repeat(32),
  });
  return built.app;
}

describe("API integration", () => {
  it("accepts valid relay request and returns status", async () => {
    const app = await setup();
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20");
    const digest = ("0x" + "11".repeat(32)) as `0x${string}`;
    const signature = await account.sign({ hash: digest });
    const payload = {
      kind: "clearMacroV1",
      chainId: 1,
      forwarder: "0x0000000000000000000000000000000000000001",
      macro: "0x0000000000000000000000000000000000000002",
      signer: account.address,
      params: makeParams(),
      signature,
    };
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
    const app = await setup();
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20");
    const digest = ("0x" + "11".repeat(32)) as `0x${string}`;
    const signature = await account.sign({ hash: digest });
    const payload = {
      kind: "clearMacroV1",
      chainId: 1,
      forwarder: "0x0000000000000000000000000000000000000001",
      macro: "0x0000000000000000000000000000000000000002",
      signer: account.address,
      params: makeParams(),
      signature,
    };
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
    const app = await setup();
    const payload = {
      kind: "clearMacroV1",
      chainId: 1,
      forwarder: "0x0000000000000000000000000000000000000001",
      macro: "0x0000000000000000000000000000000000000002",
      signer: "0x0000000000000000000000000000000000000003",
      params: makeParams(),
      signature: "0x1234",
    };
    const response = await app.inject({ method: "POST", url: "/v1/relay", payload });
    expect(response.statusCode).toBe(422);
  });

  it("returns 503 readiness when any enabled chain is not ready", async () => {
    const app = await setup({
      getChainReadiness: async () => ({ ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(503);
    expect(readyz.json<{ ready: boolean }>().ready).toBe(false);
  });

  it("returns idempotent replay even when chain later becomes unready", async () => {
    let ready = true;
    const app = await setup({
      getChainReadiness: async () => (ready ? { ready: true } : { ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20");
    const digest = ("0x" + "11".repeat(32)) as `0x${string}`;
    const signature = await account.sign({ hash: digest });
    const payload = {
      kind: "clearMacroV1",
      chainId: 1,
      forwarder: "0x0000000000000000000000000000000000000001",
      macro: "0x0000000000000000000000000000000000000002",
      signer: account.address,
      params: makeParams(),
      signature,
    };
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
});

