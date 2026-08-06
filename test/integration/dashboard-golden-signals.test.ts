import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestHarness } from "../fixtures/harness.js";
import { metricSampleValue, hasMetricSample } from "../fixtures/metrics.js";
import { buildRelayPayload } from "../fixtures/relay-fixtures.js";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
  type NewRelayExecution,
} from "../../src/db/repositories.js";
import { loadRegistry } from "../../src/config/registry.js";
import { createMetrics } from "../../src/metrics/metrics.js";
import { recordActionableFailure } from "../../src/metrics/actionableFailures.js";
import { processRelayerWorkerTick } from "../../src/relayer/worker.js";
import { processAuthorizationWorkerTick } from "../../src/relayer/authorizationWorker.js";
import { OzRelayerRateLimitError } from "../../src/relayer/errors.js";
import { sampleReadinessMetricsOnce } from "../../src/metrics/readinessMetricsSampler.js";
import { sampleOldestNonterminalAgesOnce } from "../../src/metrics/oldestNonterminalAgeSampler.js";
import * as admitModule from "../../src/api/admitRelayExecution.js";
import type { SafeClient } from "../../src/safe/client.js";

const REQUESTS = "clearmacro_requests_total";
const VALIDATION = "clearmacro_validation_failures_total";
const ACTIONABLE = "clearmacro_actionable_failures_total";
const SUBMISSION = "clearmacro_relayer_submission_total";
const POLL = "clearmacro_relayer_poll_duration_seconds";
const TERMINAL = "clearmacro_executions_terminal_total";
const READINESS = "clearmacro_readiness";
const OLDEST_AGE = "clearmacro_oldest_nonterminal_execution_age_seconds";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createExecutionInput(overrides?: Partial<NewRelayExecution>): NewRelayExecution {
  return {
    clientId: "anonymous",
    clientRequestId: null,
    requestBodyHash: "hash",
    digest: overrides?.digest ?? `0x${"aa".repeat(32)}`,
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

function workerSetup() {
  const dir = mkdtempSync(join(tmpdir(), "dash-metrics-worker-"));
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const metrics = createMetrics();
  const executions = new RelayExecutionRepository(db, metrics);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);

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

  return { executions, executionEvents, relayerTransactions, registry, metrics, db };
}

function assertNoRelayerIdLabels(metricsText: string): void {
  expect(metricsText.includes("relayer_id=")).toBe(false);
}

describe("dashboard golden signals — requests / validation", () => {
  it("records created on successful create", async () => {
    const { app, metrics } = await createTestHarness();
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(202);

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "created" })).toBe(1);
    expect(text.includes(`${VALIDATION}{`)).toBe(false);
    assertNoRelayerIdLabels(text);
  });

  it("records duplicate on same-client dedup replay", async () => {
    const { app, metrics } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(second.statusCode).toBe(200);

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "created" })).toBe(1);
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "duplicate" })).toBe(1);
  });

  it("records rejected_client and validation DUPLICATE_EXECUTION for cross-client dedup", async () => {
    const { app, metrics } = await createTestHarness({
      env: {
        apiAuthEnabled: true,
        apiClients: [
          { id: "client-a", apiTokenHash: sha256Hex("token-a") },
          { id: "client-b", apiTokenHash: sha256Hex("token-b") },
        ],
      },
    });
    const payload = await buildRelayPayload();
    const first = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      headers: { authorization: "Bearer token-a" },
      payload,
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      headers: { authorization: "Bearer token-b" },
      payload,
    });
    expect(second.statusCode).toBe(409);

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "rejected_client" })).toBe(1);
    expect(metricSampleValue(text, VALIDATION, { chain_id: "1", code: "DUPLICATE_EXECUTION" })).toBe(1);
  });

  it("records UNAUTHORIZED as rejected_client and validation", async () => {
    const { app, metrics } = await createTestHarness({ apiAuthEnabled: true });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(401);

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "rejected_client" })).toBe(1);
    expect(metricSampleValue(text, VALIDATION, { chain_id: "1", code: "UNAUTHORIZED" })).toBe(1);
  });

  it("records SIGNATURE_INVALID without actionable bump", async () => {
    const { app, metrics } = await createTestHarness({
      validateRelaySignature: async () => false,
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "rejected_client" })).toBe(1);
    expect(metricSampleValue(text, VALIDATION, { chain_id: "1", code: "SIGNATURE_INVALID" })).toBe(1);
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });

  it("records rejected_provider for PROVIDER_NOT_READY without validation", async () => {
    const { app, metrics } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(503);

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "rejected_provider" })).toBe(1);
    expect(text.includes(`${VALIDATION}{`)).toBe(false);
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "admission",
        code: "PROVIDER_NOT_READY",
      }),
    ).toBe(1);
  });

  it("records error exactly once on unexpected throw after admit", async () => {
    const { app, metrics } = await createTestHarness();
    const payload = await buildRelayPayload();
    const spy = vi.spyOn(admitModule, "finalizeCreatedExecution").mockImplementation(() => {
      throw new Error("forced finalize failure");
    });

    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(500);
    spy.mockRestore();

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, REQUESTS, { chain_id: "1", kind: "clearMacroV1", result: "error" })).toBe(1);
  });
});

describe("dashboard golden signals — worker funnel", () => {
  it("records submission outcomes accepted / retry / failed", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = workerSetup();
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

    for (let i = 0; i < 2; i++) {
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

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, SUBMISSION, { chain_id: "1", outcome: "retry" })).toBe(2);
    expect(metricSampleValue(text, SUBMISSION, { chain_id: "1", outcome: "failed" })).toBe(1);
    assertNoRelayerIdLabels(text);

    executions.createPending(createExecutionInput({ digest: `0x${"bb".repeat(32)}` }));
    const acceptClient = {
      getRelayer: relayerClient.getRelayer,
      submitTransaction: async () => ({
        id: "oz-accept",
        hash: `0x${"ee".repeat(32)}`,
        status: "pending",
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
      relayerClient: acceptClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
      metrics,
    });
    const text2 = await metrics.registry.metrics();
    expect(metricSampleValue(text2, SUBMISSION, { chain_id: "1", outcome: "accepted" })).toBe(1);
  });

  it("observes poll latency including errors and 429", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = workerSetup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-poll" });

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
        throw new OzRelayerRateLimitError("rate limited", 429, "/transactions/oz-poll");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      ozPollBackoff: { until: 0 },
      preflightSimulation: async () => "ok",
      metrics,
    });

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, `${POLL}_count`, { chain_id: "1" })).toBe(1);
    assertNoRelayerIdLabels(text);
  });

  it("increments terminal counter once on poll success and re-poll is idempotent", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = workerSetup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-success" });

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
        id: "oz-success",
        hash: `0x${"cd".repeat(32)}`,
        status: "confirmed",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        confirmed_at: new Date().toISOString(),
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
        mined_at: new Date().toISOString(),
        receipt: {
          transactionHash: `0x${"cd".repeat(32)}`,
          blockNumber: "1",
          status: "success",
        },
      }),
    };

    for (let i = 0; i < 2; i++) {
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
    }

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, TERMINAL, { chain_id: "1", state: "succeeded", code: "none" }),
    ).toBe(1);
  });

  it("finalizeCreatedExecution no-ops when worker already terminalized", async () => {
    const { app, metrics, executions, relayerTransactions } = await createTestHarness();
    const payload = await buildRelayPayload();
    const created = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(created.statusCode).toBe(202);
    const id = created.json<{ id: string }>().id;

    relayerTransactions.upsert({
      ozTransactionId: "oz-race-1",
      executionId: id,
      ozRelayerId: "relayer-main",
      status: "failed",
      statusReason: "insufficient funds",
      txHash: `0x${"cd".repeat(32)}`,
      nonce: "1",
      gasLimit: "21000",
      gasPrice: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      rawJson: "{}",
      submittedAt: new Date().toISOString(),
      includedAt: null,
      confirmedAt: null,
      receiptJson: null,
      lastPolledAt: new Date().toISOString(),
    });
    executions.applySubmitAcknowledgement(id, "oz-race-1", `0x${"cd".repeat(32)}`);
    // Worker wins the race.
    executions.transitionState(id, "failed", {
      errorJson: JSON.stringify({
        code: "RELAYER_FAILED",
        message: "Relayer failed to execute transaction.",
        category: "relayer",
        retryable: false,
      }),
    });
    recordActionableFailure(metrics, {
      chainId: 1,
      stage: "worker_poll",
      code: "RELAYER_FAILED",
    });

    const before = await metrics.registry.metrics();
    const actionableBefore =
      metricSampleValue(before, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_poll",
        code: "RELAYER_FAILED",
      }) ?? 0;

    const replay = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ state: string }>().state).toBe("failed");

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_poll",
        code: "RELAYER_FAILED",
      }),
    ).toBe(actionableBefore);
  });

  it("finalizeCreatedExecution persists RELAYER_FAILED and pages actionable", async () => {
    const { app, metrics, executions, relayerTransactions } = await createTestHarness();
    const payload = await buildRelayPayload();
    const created = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(created.statusCode).toBe(202);
    const id = created.json<{ id: string }>().id;

    // Simulate a prior OZ tx that failed without a revert reason (provider/relayer fault).
    relayerTransactions.upsert({
      ozTransactionId: "oz-failed-1",
      executionId: id,
      ozRelayerId: "relayer-main",
      status: "failed",
      statusReason: "insufficient funds",
      txHash: `0x${"ab".repeat(32)}`,
      nonce: "1",
      gasLimit: "21000",
      gasPrice: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      rawJson: "{}",
      submittedAt: new Date().toISOString(),
      includedAt: null,
      confirmedAt: null,
      receiptJson: null,
      lastPolledAt: new Date().toISOString(),
    });
    executions.applySubmitAcknowledgement(id, "oz-failed-1", `0x${"ab".repeat(32)}`);

    const before = await metrics.registry.metrics();
    const actionableBefore =
      metricSampleValue(before, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_poll",
        code: "RELAYER_FAILED",
      }) ?? 0;

    // Same-client dedup hits finalizeCreatedExecution recovery.
    const replay = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ state: string }>().state).toBe("failed");

    const row = executions.getByIdOrThrow(id);
    expect(row.lastErrorJson).toContain("RELAYER_FAILED");

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_poll",
        code: "RELAYER_FAILED",
      }),
    ).toBe(actionableBefore + 1);
    expect(
      metricSampleValue(text, TERMINAL, {
        chain_id: "1",
        state: "failed",
        code: "RELAYER_FAILED",
      }),
    ).toBe(1);
  });

  it("post-accept persistence failure does not emit RELAYER_SUBMIT_FAILED or resubmit", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = workerSetup();
    const created = executions.createPending(createExecutionInput());
    let submitCalls = 0;

    const relayerClient = {
      ready: async () => true,
      listRelayerIds: async () => ["relayer-main"],
      getRelayer: async () => ({
        address: "0x00000000000000000000000000000000000000aa",
        paused: false,
        system_disabled: false,
      }),
      getNetwork: async () => ({ id: "eip155:1", network_type: "evm", required_confirmations: 1 }),
      submitTransaction: async () => {
        submitCalls += 1;
        return {
          id: "oz-1",
          status: "pending",
          status_reason: null,
          hash: null,
          nonce: 1,
          gas_limit: 21000,
          gas_price: null,
          max_fee_per_gas: null,
          max_priority_fee_per_gas: null,
          sent_at: new Date().toISOString(),
          mined_at: null,
          confirmed_at: null,
          receipt: null,
        };
      },
      getTransaction: async () => {
        throw new Error("unused");
      },
    };

    const upsertSpy = vi.spyOn(relayerTransactions, "upsert").mockImplementation(() => {
      throw new Error("db down after accept");
    });

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 1,
      preflightSimulation: async () => "ok",
      metrics,
    });
    // Second tick must not resubmit: OZ id is already on the execution row.
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 1,
      preflightSimulation: async () => "ok",
      metrics,
    });
    upsertSpy.mockRestore();

    expect(submitCalls).toBe(1);
    expect(executions.getByIdOrThrow(created.id).ozTransactionId).toBe("oz-1");

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, SUBMISSION, { chain_id: "1", outcome: "accepted" }),
    ).toBe(1);
    expect(
      metricSampleValue(text, SUBMISSION, { chain_id: "1", outcome: "failed" }),
    ).toBeUndefined();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_submit",
        code: "RELAYER_SUBMIT_FAILED",
      }),
    ).toBeUndefined();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_submit",
        code: "INTERNAL_INVARIANT",
      }),
    ).toBe(1);
  });

  it("terminalizes non-transient pre-submit failures as INTERNAL_INVARIANT once", async () => {
    const { executions, executionEvents, relayerTransactions, registry, metrics } = workerSetup();
    const created = executions.createPending(createExecutionInput());
    let getRelayerCalls = 0;
    const relayerClient = {
      getRelayer: async () => {
        getRelayerCalls += 1;
        throw new Error("relayer config missing");
      },
      submitTransaction: async () => {
        throw new Error("should not submit");
      },
      getTransaction: async () => {
        throw new Error("unused");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 1,
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
      submitRetryCount: 1,
      preflightSimulation: async () => "ok",
      metrics,
    });

    expect(getRelayerCalls).toBe(1);
    expect(executions.getByIdOrThrow(created.id).state).toBe("failed");
    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "worker_submit",
        code: "INTERNAL_INVARIANT",
      }),
    ).toBe(1);
  });

  it("increments terminal counter from authorization worker reject", async () => {
    const { executions, executionEvents, registry, metrics } = workerSetup();
    const row = executions.createAwaitingAuthorization({
      ...createExecutionInput(),
      authorizationType: "safeMessageV1" as const,
      safeMessageHash: `0x${"cc".repeat(32)}`,
      signature: null,
    });

    const safeClient: SafeClient = {
      isChainSupported: () => true,
      assertEoaOwners: async () => {},
      getMessage: async () => ({
        safe: row.signerAddress,
        messageHash: row.safeMessageHash!,
        preparedSignature: "0x1234",
        messageDigest: row.digest as `0x${string}`,
      }),
    };

    await processAuthorizationWorkerTick({
      executions,
      executionEvents,
      registry,
      safeClient,
      batchSize: 10,
      pollBaseDelayMs: 1000,
      pollMaxDelayMs: 5000,
      metrics,
      validateRelaySignature: async () => true,
      preflightSimulation: async () => "deterministic_revert",
      getRelayerSigner: async () => "0x0000000000000000000000000000000000000010",
    });

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, TERMINAL, { chain_id: "1", state: "rejected", code: "PREFLIGHT_REVERTED" }),
    ).toBe(1);
  });
});

describe("dashboard golden signals — samplers", () => {
  it("cleans stale readiness reasons on transition to ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-readiness-"));
    writeFileSync(
      join(dir, "provider.json"),
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0x0000000000000000000000000000000000000001",
            rpcUrls: ["http://localhost:8545"],
            macroPolicy: { mode: "open" },
          },
        ],
      }),
    );
    const registry = loadRegistry(join(dir, "provider.json"));
    const metrics = createMetrics();

    await sampleReadinessMetricsOnce({
      registry,
      getChainReadiness: async () => ({ ready: false, reasonCode: "RELAYER_UNAVAILABLE" }),
      metrics,
    });
    let text = await metrics.registry.metrics();
    expect(hasMetricSample(text, READINESS, { chain_id: "1", reason: "RELAYER_UNAVAILABLE" })).toBe(true);
    expect(hasMetricSample(text, READINESS, { chain_id: "1", reason: "none" })).toBe(false);

    await sampleReadinessMetricsOnce({
      registry,
      getChainReadiness: async () => ({ ready: true }),
      metrics,
      previousReasonByChainId: new Map([[1, "RELAYER_UNAVAILABLE"]]),
    });
    text = await metrics.registry.metrics();
    expect(hasMetricSample(text, READINESS, { chain_id: "1", reason: "RELAYER_UNAVAILABLE" })).toBe(false);
    expect(metricSampleValue(text, READINESS, { chain_id: "1", reason: "none" })).toBe(1);
  });

  it("replaces readiness reason A with reason B", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-readiness-"));
    writeFileSync(
      join(dir, "provider.json"),
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0x0000000000000000000000000000000000000001",
            rpcUrls: ["http://localhost:8545"],
            macroPolicy: { mode: "open" },
          },
        ],
      }),
    );
    const registry = loadRegistry(join(dir, "provider.json"));
    const metrics = createMetrics();

    await sampleReadinessMetricsOnce({
      registry,
      getChainReadiness: async () => ({ ready: false, reasonCode: "RELAYER_UNAVAILABLE" }),
      metrics,
    });
    await sampleReadinessMetricsOnce({
      registry,
      getChainReadiness: async () => ({ ready: false, reasonCode: "PROVIDER_NOT_READY" }),
      metrics,
      previousReasonByChainId: new Map([[1, "RELAYER_UNAVAILABLE"]]),
    });

    const text = await metrics.registry.metrics();
    expect(hasMetricSample(text, READINESS, { chain_id: "1", reason: "RELAYER_UNAVAILABLE" })).toBe(false);
    expect(metricSampleValue(text, READINESS, { chain_id: "1", reason: "PROVIDER_NOT_READY" })).toBe(0);
  });

  it("continues sampling other chains when one probe throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-readiness-"));
    writeFileSync(
      join(dir, "provider.json"),
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0x0000000000000000000000000000000000000001",
            rpcUrls: ["http://localhost:8545"],
            macroPolicy: { mode: "open" },
          },
          {
            chainId: 2,
            forwarderAddress: "0x0000000000000000000000000000000000000002",
            rpcUrls: ["http://localhost:8545"],
            macroPolicy: { mode: "open" },
          },
        ],
      }),
    );
    const registry = loadRegistry(join(dir, "provider.json"));
    const metrics = createMetrics();

    await sampleReadinessMetricsOnce({
      registry,
      getChainReadiness: async (chainId) => {
        if (chainId === 1) {
          throw new Error("probe failed");
        }
        return { ready: true };
      },
      metrics,
    });

    const text = await metrics.registry.metrics();
    expect(metricSampleValue(text, READINESS, { chain_id: "1", reason: "PROVIDER_NOT_READY" })).toBe(0);
    expect(metricSampleValue(text, READINESS, { chain_id: "2", reason: "none" })).toBe(1);
  });

  it("reports oldest pending age and zeros after terminalize", async () => {
    const { executions, registry, metrics, db } = workerSetup();
    const oldCreatedAt = new Date(Date.now() - 120_000).toISOString();
    const row = executions.createPending(createExecutionInput());
    db.db.prepare("UPDATE relay_executions SET created_at = ? WHERE id = ?").run(oldCreatedAt, row.id);

    await sampleOldestNonterminalAgesOnce({ registry, executions, metrics });
    let text = await metrics.registry.metrics();
    const age = metricSampleValue(text, OLDEST_AGE, { chain_id: "1", state: "pending" });
    expect(age).toBeDefined();
    expect(age!).toBeGreaterThanOrEqual(110);

    executions.transitionState(row.id, "failed", {
      errorJson: JSON.stringify({
        code: "RELAYER_SUBMIT_FAILED",
        message: "done",
        category: "relayer",
        retryable: false,
      }),
    });
    await sampleOldestNonterminalAgesOnce({ registry, executions, metrics });
    text = await metrics.registry.metrics();
    expect(metricSampleValue(text, OLDEST_AGE, { chain_id: "1", state: "pending" })).toBe(0);
  });
});
