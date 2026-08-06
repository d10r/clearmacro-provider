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
import { OzRelayerRateLimitError } from "../../src/relayer/errors.js";
import { loadRegistry } from "../../src/config/registry.js";
import { createMetrics } from "../../src/metrics/metrics.js";
import { metricSampleValue } from "../fixtures/metrics.js";

const ACTIONABLE = "clearmacro_actionable_failures_total";
const OPERATIONAL = "clearmacro_operational_retries_total";

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
  const dir = mkdtempSync(join(tmpdir(), "actionable-worker-"));
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const executions = new RelayExecutionRepository(db);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const metrics = createMetrics();

  const registryPath = join(dir, "provider.json");
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

  return { executions, executionEvents, relayerTransactions, registry, metrics };
}

async function metricsText(metrics: ReturnType<typeof createMetrics>): Promise<string> {
  return metrics.registry.metrics();
}

describe("actionable failure metrics — relayer worker", () => {
  it("increments RELAYER_SUBMIT_FAILED once when submit retries exhaust", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = setup();
    executions.createPending(createExecutionInput());
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

    for (let i = 0; i < 3; i++) {
      await processRelayerWorkerTick({
        executions,
        executionEvents,
        relayerTransactions,
        relayerClient: relayerClient as never,
        registry,
        batchSize: 10,
        submitRetryCount: 3,
        preflightSimulation: async () => "ok",
        metrics,
      });
    }

    const text = await metricsText(metrics);
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_submit",
        code: "RELAYER_SUBMIT_FAILED",
      }),
    ).toBe(1);
  });

  it("increments RELAYER_FAILED once and stays idempotent on re-poll", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-fail" });

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
        id: "oz-tx-fail",
        hash: "0x" + "cd".repeat(32),
        status: "failed",
        status_reason: "nonce too low",
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
      metrics,
    });
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
      metrics,
    });

    const text = await metricsText(metrics);
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_poll",
        code: "RELAYER_FAILED",
      }),
    ).toBe(1);
  });

  it("does not increment actionable counter for ordinary onchain revert", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-revert" });

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
        id: "oz-tx-revert",
        hash: "0x" + "ee".repeat(32),
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
      metrics,
    });

    const text = await metricsText(metrics);
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
    expect(executions.getByIdOrThrow(created.id).state).toBe("reverted");
  });

  it("increments operational retry for preflight rpc_unavailable without terminal actionable", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = setup();
    executions.createPending(createExecutionInput());
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
      metrics,
    });

    const text = await metricsText(metrics);
    expect(
      metricSampleValue(text, OPERATIONAL, {
        chain_id: "1",
        stage: "worker_preflight",
        reason: "preflight_rpc_unavailable",
      }),
    ).toBe(1);
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });

  it("increments operational retries for poll 429 and poll errors", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-poll" });
    const ozPollBackoff = { until: 0 };

    const rateLimitedClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => {
        throw new OzRelayerRateLimitError("rl", 429, "/", 200);
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: rateLimitedClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
      ozPollBackoff,
      metrics,
    });

    let text = await metricsText(metrics);
    expect(
      metricSampleValue(text, OPERATIONAL, {
        chain_id: "1",
        stage: "worker_poll",
        reason: "relayer_poll_rate_limited",
      }),
    ).toBe(1);

    const errorClient = {
      ...rateLimitedClient,
      getTransaction: async () => {
        throw new Error("bad envelope");
      },
    };
    ozPollBackoff.until = 0;

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: errorClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
      ozPollBackoff,
      metrics,
    });

    text = await metricsText(metrics);
    expect(
      metricSampleValue(text, OPERATIONAL, {
        chain_id: "1",
        stage: "worker_poll",
        reason: "relayer_poll_error",
      }),
    ).toBe(1);
  });
});
