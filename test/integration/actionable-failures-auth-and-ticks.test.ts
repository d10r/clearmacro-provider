import { describe, expect, it, vi } from "vitest";
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
import { processAuthorizationWorkerTick } from "../../src/relayer/authorizationWorker.js";
import { loadRegistry } from "../../src/config/registry.js";
import type { SafeClient } from "../../src/safe/client.js";
import { SafeApiError, SafeMessageUnsupportedError } from "../../src/safe/errors.js";
import { createMetrics } from "../../src/metrics/metrics.js";
import { runRelayerAndAuthorizationTicks } from "../../src/relayer/workerTicks.js";
import { metricSampleValue } from "../fixtures/metrics.js";

const ACTIONABLE = "clearmacro_actionable_failures_total";
const OPERATIONAL = "clearmacro_operational_retries_total";

function createAwaitingInput(overrides?: Partial<NewRelayExecution>): NewRelayExecution {
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
    signerAddress: "0x00000000000000000000000000000000000000bb",
    nonce: "1",
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 3600),
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
  const dir = mkdtempSync(join(tmpdir(), "actionable-auth-"));
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

function stubSafeClient(overrides?: Partial<SafeClient>): SafeClient {
  return {
    isChainSupported: () => true,
    assertEoaOwners: async () => {},
    getMessage: async () => ({
      safe: "0x00000000000000000000000000000000000000bb",
      messageHash: `0x${"cc".repeat(32)}`,
      preparedSignature: null,
      messageDigest: `0x${"aa".repeat(32)}`,
    }),
    ...overrides,
  };
}

describe("actionable failure metrics — authorization worker", () => {
  it("increments actionable counter for non-retryable Safe API failure", async () => {
    const ctx = setup();
    ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick({
      executions: ctx.executions,
      executionEvents: ctx.executionEvents,
      registry: ctx.registry,
      safeClient: stubSafeClient({
        getMessage: async () => {
          throw new SafeApiError("Safe API authentication failed.", 401, false, "SAFE_API_UNAUTHORIZED");
        },
      }),
      batchSize: 10,
      pollBaseDelayMs: 100,
      pollMaxDelayMs: 1000,
      metrics: ctx.metrics,
      validateRelaySignature: async () => false,
      getRelayerSigner: async () => "0x0000000000000000000000000000000000000010",
    });

    const text = await ctx.metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "1",
        stage: "authorization",
        code: "SAFE_API_UNAUTHORIZED",
      }),
    ).toBe(1);
  });

  it("increments operational retry for retryable Safe API backoff", async () => {
    const ctx = setup();
    ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick({
      executions: ctx.executions,
      executionEvents: ctx.executionEvents,
      registry: ctx.registry,
      safeClient: stubSafeClient({
        getMessage: async () => {
          throw new SafeApiError("Safe API unavailable.", 503, true, "SAFE_API_UNAVAILABLE");
        },
      }),
      batchSize: 10,
      pollBaseDelayMs: 100,
      pollMaxDelayMs: 1000,
      metrics: ctx.metrics,
      validateRelaySignature: async () => false,
      getRelayerSigner: async () => "0x0000000000000000000000000000000000000010",
    });

    const text = await ctx.metrics.registry.metrics();
    expect(
      metricSampleValue(text, OPERATIONAL, {
        chain_id: "1",
        stage: "authorization",
        reason: "safe_api_retryable",
      }),
    ).toBe(1);
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });

  it("increments operational retry for authorization preflight RPC unavailable", async () => {
    const ctx = setup();
    ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick({
      executions: ctx.executions,
      executionEvents: ctx.executionEvents,
      registry: ctx.registry,
      safeClient: stubSafeClient({
        getMessage: async () => ({
          safe: "0x00000000000000000000000000000000000000bb",
          messageHash: `0x${"cc".repeat(32)}`,
          preparedSignature: "0xabcd",
          messageDigest: `0x${"aa".repeat(32)}`,
        }),
      }),
      batchSize: 10,
      pollBaseDelayMs: 100,
      pollMaxDelayMs: 1000,
      metrics: ctx.metrics,
      validateRelaySignature: async () => true,
      getRelayerSigner: async () => "0x0000000000000000000000000000000000000010",
      preflightSimulation: async () => "rpc_unavailable",
    });

    const text = await ctx.metrics.registry.metrics();
    expect(
      metricSampleValue(text, OPERATIONAL, {
        chain_id: "1",
        stage: "authorization",
        reason: "preflight_rpc_unavailable",
      }),
    ).toBe(1);
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });

  it("increments actionable counter for INVALID_AUTHORIZATION_STATE", async () => {
    const ctx = setup();
    ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput({ chainId: 999 }),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick({
      executions: ctx.executions,
      executionEvents: ctx.executionEvents,
      registry: ctx.registry,
      safeClient: stubSafeClient(),
      batchSize: 10,
      pollBaseDelayMs: 100,
      pollMaxDelayMs: 1000,
      metrics: ctx.metrics,
      validateRelaySignature: async () => false,
      getRelayerSigner: async () => "0x0000000000000000000000000000000000000010",
    });

    const text = await ctx.metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "999",
        stage: "authorization",
        code: "INVALID_AUTHORIZATION_STATE",
      }),
    ).toBe(1);
  });

  it("does not increment actionable counter for SAFE_AUTHORIZATION_UNSUPPORTED", async () => {
    const ctx = setup();
    ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick({
      executions: ctx.executions,
      executionEvents: ctx.executionEvents,
      registry: ctx.registry,
      safeClient: stubSafeClient({
        getMessage: async () => {
          throw new SafeMessageUnsupportedError("unsupported Safe shape");
        },
      }),
      batchSize: 10,
      pollBaseDelayMs: 100,
      pollMaxDelayMs: 1000,
      metrics: ctx.metrics,
      validateRelaySignature: async () => false,
      getRelayerSigner: async () => "0x0000000000000000000000000000000000000010",
    });

    const text = await ctx.metrics.registry.metrics();
    expect(text.includes(`${ACTIONABLE}{`)).toBe(false);
  });
});

describe("actionable failure metrics — worker ticks", () => {
  it("records distinct worker_tick codes for relayer vs authorization failures", async () => {
    const metrics = createMetrics();
    const log = { error: vi.fn() };

    await runRelayerAndAuthorizationTicks({
      processRelayerWorkerTick: async () => {
        throw new Error("relayer tick boom");
      },
      processAuthorizationWorkerTick: async () => {
        throw new Error("authorization tick boom");
      },
      metrics,
      log,
    });

    const text = await metrics.registry.metrics();
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "unknown",
        stage: "worker_tick",
        code: "RELAYER_WORKER_TICK_FAILED",
      }),
    ).toBe(1);
    expect(
      metricSampleValue(text, ACTIONABLE, {
        chain_id: "unknown",
        stage: "worker_tick",
        code: "AUTHORIZATION_WORKER_TICK_FAILED",
      }),
    ).toBe(1);
  });
});
