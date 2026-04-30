import { loadEnv } from "./config/env.js";
import { loadRegistry } from "./config/registry.js";
import { bindRelayersToRegistry } from "./config/relayerDiscovery.js";
import { openDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "./db/repositories.js";
import { OzRelayerClient } from "./relayer/client.js";
import { processRelayerWorkerTick } from "./relayer/worker.js";
import { createApp } from "./app.js";
import { evaluateChainReadiness, getForwarderDigest, validateRelaySignature } from "./chain/readiness.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = loadRegistry(env.registryPath);
  const db = openDatabase(env.databasePath);
  if (env.runMigrationsOnStart) {
    runMigrations(db);
  }

  const executions = new RelayExecutionRepository(db);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const createRequestAudit = new CreateRequestAuditLogRepository(db);
  const relayerClient = new OzRelayerClient(env.ozRelayerUrl, env.ozRelayerApiKey, env.relayerRequestTimeoutMs);

  await bindRelayersToRegistry(registry, relayerClient);

  const { app } = await createApp({
    registry,
    executions,
    executionEvents,
    relayerTransactions,
    createRequestAudit,
    providerName: env.providerName,
    relayerClient,
    env: { apiAuthEnabled: env.apiAuthEnabled, apiClients: env.apiClients },
    requestMaxMetadataKeys: env.requestMaxMetadataKeys,
    requestMaxMetadataValueLength: env.requestMaxMetadataValueLength,
    logLevel: env.logLevel,
    getChainReadiness: (chainId) => evaluateChainReadiness({ registry, chainId, relayerClient }),
    getForwarderDigest: (input) =>
      getForwarderDigest({
        registry,
        chainId: input.chainId,
        forwarder: input.forwarder,
        macro: input.macro,
        params: input.params,
      }),
    validateRelaySignature: (input) =>
      validateRelaySignature({
        registry,
        chainId: input.chainId,
        signer: input.signer,
        digest: input.digest,
        signature: input.signature,
      }),
  });

  if (env.relayerWorkerEnabled) {
    let tickInFlight = false;
    setInterval(() => {
      if (tickInFlight) {
        return;
      }
      tickInFlight = true;
      processRelayerWorkerTick({
        executions,
        executionEvents,
        relayerTransactions,
        relayerClient,
        registry,
        batchSize: env.relayerWorkerBatchSize,
        submitRetryCount: 3,
      })
        .catch((error) => {
          app.log.error({ err: error }, "Relayer worker tick failed");
        })
        .finally(() => {
          tickInFlight = false;
        });
    }, env.relayerWorkerPollIntervalMs);
  }

  await app.listen({ host: env.host, port: env.port });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
