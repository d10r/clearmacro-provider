import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  AuditEventRepository,
  RelayRequestRepository,
  RelayerTransactionRepository,
  type NewRelayRequest,
} from "../../src/db/repositories.js";
import { processRelayerWorkerTick } from "../../src/relayer/worker.js";
import { loadRegistry } from "../../src/config/registry.js";

function createRequestInput(overrides?: Partial<NewRelayRequest>): NewRelayRequest {
  return {
    clientId: "anonymous",
    clientRequestId: null,
    idempotencyKey: null,
    requestBodyHash: "hash",
    kind: "clearMacroV1",
    chainId: 1,
    ozRelayerId: "relayer-main",
    forwarder: "0x0000000000000000000000000000000000000001",
    macro: "0x0000000000000000000000000000000000000002",
    signer: "0x0000000000000000000000000000000000000003",
    provider: "macros.superfluid.eth",
    clearMacroNonce: "1",
    validAfter: "0",
    validBefore: "0",
    msgValue: "0",
    params: "0x1234",
    signature: "0x1234",
    permit2Json: null,
    metadataJson: "{}",
    requiredConfirmations: 1,
    ...overrides,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "worker-test-"));
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const requests = new RelayRequestRepository(db);
  const audits = new AuditEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);

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

  return { requests, audits, relayerTransactions, registry };
}

describe("relayer worker", () => {
  it("submits accepted request and transitions to pending", async () => {
    const { requests, audits, relayerTransactions, registry } = setup();
    const created = requests.createAccepted(createRequestInput());

    const relayerClient = {
      submitTransaction: async () => ({
        id: "oz-tx-1",
        hash: "0x" + "ab".repeat(32),
        status: "submitted",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        confirmed_at: null,
        gas_price: "1",
        gas_limit: 21000,
        nonce: 1,
        value: "0",
        from: "0x0000000000000000000000000000000000000010",
        to: "0x0000000000000000000000000000000000000001",
        relayer_id: "relayer-main",
        data: "0x",
        max_fee_per_gas: null,
        max_priority_fee_per_gas: null,
      }),
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      requests,
      audits,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const updated = requests.getByIdOrThrow(created.id);
    expect(updated.state).toBe("pending");
    expect(updated.ozTransactionId).toBe("oz-tx-1");
    const relayer = relayerTransactions.getByRequestId(created.id);
    expect(relayer?.status).toBe("submitted");
  });

  it("projects pending request to reverted on failed revert reason", async () => {
    const { requests, audits, relayerTransactions, registry } = setup();
    const created = requests.createAccepted(createRequestInput());
    requests.transitionState(created.id, "queued");
    requests.transitionState(created.id, "pending", { ozTransactionId: "oz-tx-1" });

    const relayerClient = {
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => ({
        id: "oz-tx-1",
        hash: "0x" + "cd".repeat(32),
        status: "failed",
        status_reason: "execution reverted: test",
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        confirmed_at: null,
        gas_price: "1",
        gas_limit: 21000,
        nonce: 1,
        value: "0",
        from: "0x0000000000000000000000000000000000000010",
        to: "0x0000000000000000000000000000000000000001",
        relayer_id: "relayer-main",
        data: "0x",
        max_fee_per_gas: null,
        max_priority_fee_per_gas: null,
      }),
    };

    await processRelayerWorkerTick({
      requests,
      audits,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const updated = requests.getByIdOrThrow(created.id);
    expect(updated.state).toBe("reverted");
    expect(updated.terminal).toBe(1);
  });
});

