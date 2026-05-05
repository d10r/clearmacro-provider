import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
  type NewRelayExecution,
} from "../../src/db/repositories.js";
import { processRelayerWorkerTick } from "../../src/relayer/worker.js";
import { loadRegistry } from "../../src/config/registry.js";

function createExecutionInput(overrides?: Partial<NewRelayExecution>): NewRelayExecution {
  return {
    clientId: "anonymous",
    clientRequestId: null,
    requestBodyHash: "hash",
    digest: overrides?.digest ?? "0x" + "aa".repeat(32),
    domain: "test",
    kind: "clearMacroV1",
    chainId: 1,
    ozRelayerId: "relayer-main",
    forwarderAddress: "0x0000000000000000000000000000000000000001",
    macroAddress: "0x0000000000000000000000000000000000000002",
    signerAddress: "0x0000000000000000000000000000000000000003",
    nonce: "1",
    validAfter: "0",
    validBefore: "0",
    value: "0",
    payload: "0x1234",
    signature: "0x1234",
    permit2Json: null,
    metadataJson: "{}",
    forceAfterPreflightRevert: 0,
    requiredConfirmations: 1,
    ...overrides,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "worker-test-"));
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const executions = new RelayExecutionRepository(db);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);

  const registryPath = join(dir, "registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: ["http://localhost:8545"],
          macroPolicy: {
            mode: "allowlist",
            allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
          },
        },
      ],
    }),
  );
  const registry = loadRegistry(registryPath);
  registry.relayerIdByChainId.set(1, "relayer-main");
  registry.requiredConfirmationsByChainId.set(1, 1);

  return { executions, executionEvents, relayerTransactions, registry };
}

describe("relayer worker", () => {
  it("submits pending execution and transitions to submitted when hash exists", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());

    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
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
        mined_at: null,
        receipt: null,
      }),
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("submitted");
    expect(updated.ozTransactionId).toBe("oz-tx-1");
    expect(updated.currentTransactionHash).toBe("0x" + "ab".repeat(32));
    const relayer = relayerTransactions.getByExecutionId(created.id);
    expect(relayer?.status).toBe("submitted");
  });

  it("projects submitted execution to reverted on failed revert reason", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-1" });

    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
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
        mined_at: null,
        receipt: null,
      }),
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("reverted");
    expect(updated.terminal).toBe(1);
  });

  it("retries transient submit failures before failed", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("Relayer HTTP 503");
      },
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 3,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 3,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 3,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("failed");

    const events = executionEvents.listByExecution(created.id);
    expect(events.some((e) => e.type === "relayer_submit_retry_scheduled")).toBe(true);
    expect(events.some((e) => e.type === "terminal_error_set")).toBe(true);
  });

  it("passes signer and calldata inputs to preflight simulation", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(
      createExecutionInput({
        signerAddress: "0x00000000000000000000000000000000000000aa",
        signature: "0xbeef",
        payload: "0x9999",
      }),
    );
    const preflightCalls: Array<{ signer: string; signature: string; params: string }> = [];
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => ({
        id: "oz-tx-preflight",
        hash: "0x" + "12".repeat(32),
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
        mined_at: null,
        receipt: null,
      }),
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async (input) => {
        preflightCalls.push({ signer: input.signer, signature: input.signature, params: input.params });
        return "ok";
      },
    });

    expect(preflightCalls).toHaveLength(1);
    expect(preflightCalls[0]).toEqual({
      signer: "0x00000000000000000000000000000000000000aa",
      signature: "0xbeef",
      params: "0x9999",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
  });

  it("keeps execution pending when preflight reports rpc_unavailable", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("should not submit");
      },
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "rpc_unavailable",
    });

    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");
    expect(executionEvents.listByExecution(created.id).some((e) => e.type === "preflight_retry_scheduled")).toBe(true);
  });

  it("skips worker preflight when force-after-preflight flag is set", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    executions.createPending(createExecutionInput({ forceAfterPreflightRevert: 1 }));
    let preflightCalls = 0;
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => ({
        id: "oz-tx-force",
        hash: "0x" + "01".repeat(32),
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
        mined_at: null,
        receipt: null,
      }),
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => {
        preflightCalls += 1;
        return "deterministic_revert";
      },
    });

    expect(preflightCalls).toBe(0);
  });

  it("keeps submitted state for unknown non-terminal relayer statuses with hash", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-2" });
    executions.appendCurrentHashChange(created.id, `0x${"ef".repeat(32)}`);
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => ({
        id: "oz-tx-2",
        hash: "0x" + "ef".repeat(32),
        status: "replaced",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        confirmed_at: null,
        gas_price: "1",
        gas_limit: 21000,
        nonce: 2,
        value: "0",
        from: "0x0000000000000000000000000000000000000010",
        to: "0x0000000000000000000000000000000000000001",
        relayer_id: "relayer-main",
        data: "0x",
        max_fee_per_gas: null,
        max_priority_fee_per_gas: null,
        mined_at: null,
        receipt: null,
      }),
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
  });

  it("records polling audit event when status lookup errors", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-3" });
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => {
        throw new Error("bad envelope");
      },
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
    expect(executionEvents.listByExecution(created.id).some((event) => event.type === "relayer_status_polled")).toBe(true);
  });

  it("projects mined success with pending confirmations to submitted", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput({ requiredConfirmations: 2 }));
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-4" });
    executions.appendCurrentHashChange(created.id, `0x${"11".repeat(32)}`);
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => ({
        id: "oz-tx-4",
        hash: "0x" + "11".repeat(32),
        status: "mined",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        mined_at: new Date().toISOString(),
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
        receipt: {
          transactionHash: "0x" + "11".repeat(32),
          blockNumber: "1",
          status: "0x1",
        },
      }),
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
  });

  it("rejects with terminal rejected when post-creation preflight deterministically reverts", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => {
        throw new Error("not used");
      },
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "deterministic_revert",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("rejected");
    expect(executions.getByIdOrThrow(created.id).terminal).toBe(1);
  });
});
