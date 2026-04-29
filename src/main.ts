import { loadEnv } from "./config/env.js";
import { loadRegistry } from "./config/registry.js";
import { openDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import { AuditEventRepository, RelayRequestRepository, RelayerTransactionRepository } from "./db/repositories.js";
import { OzRelayerClient } from "./relayer/client.js";
import { processRelayerWorkerTick } from "./relayer/worker.js";
import { createApp } from "./app.js";
import { evaluateChainReadiness, getForwarderDigest } from "./chain/readiness.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = loadRegistry(env);
  const db = openDatabase(env.databasePath);
  if (env.runMigrationsOnStart) {
    runMigrations(db);
  }

  const requests = new RelayRequestRepository(db);
  const audits = new AuditEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const relayerClient = new OzRelayerClient(env.ozRelayerUrl, env.ozRelayerApiKey, env.relayerRequestTimeoutMs);

  const { app } = await createApp({
    registry,
    requests,
    audits,
    relayerTransactions,
    apiAuthEnabled: env.apiAuthEnabled,
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
  });

  if (env.relayerWorkerEnabled) {
    setInterval(() => {
      processRelayerWorkerTick({
        requests,
        audits,
        relayerTransactions,
        relayerClient,
        registry,
        batchSize: env.relayerWorkerBatchSize,
      }).catch((error) => {
        app.log.error({ err: error }, "Relayer worker tick failed");
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

