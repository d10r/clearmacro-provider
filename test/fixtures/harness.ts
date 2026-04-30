import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadRegistry } from "../../src/config/registry.js";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "../../src/db/repositories.js";

export type HarnessOverrides = {
  apiAuthEnabled?: boolean;
  requestMaxMetadataKeys?: number;
  requestMaxMetadataValueLength?: number;
  getChainReadiness?: AppDeps["getChainReadiness"];
  getForwarderDigest?: AppDeps["getForwarderDigest"];
  validateRelaySignature?: AppDeps["validateRelaySignature"];
};

export function writeRegistryFixture(baseDir: string, overrides?: { confirmations?: number }) {
  const registryPath = join(baseDir, "registry.json");
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
          confirmations: overrides?.confirmations ?? 1,
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
  return registryPath;
}

export async function createTestHarness(overrides?: HarnessOverrides) {
  const dir = mkdtempSync(join(tmpdir(), "cm-harness-"));
  const registryPath = writeRegistryFixture(dir);
  const registry = loadRegistry({ registryPath, defaultConfirmations: 1 });
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const executions = new RelayExecutionRepository(db);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const built = await createApp({
    registry,
    executions,
    executionEvents,
    relayerTransactions,
    apiAuthEnabled: overrides?.apiAuthEnabled ?? false,
    requestMaxMetadataKeys: overrides?.requestMaxMetadataKeys ?? 20,
    requestMaxMetadataValueLength: overrides?.requestMaxMetadataValueLength ?? 256,
    logLevel: "error",
    getChainReadiness: overrides?.getChainReadiness ?? (async () => ({ ready: true })),
    getForwarderDigest: overrides?.getForwarderDigest ?? (async () => `0x${"11".repeat(32)}`),
    validateRelaySignature: overrides?.validateRelaySignature ?? (async () => true),
  });
  return {
    dir,
    app: built.app,
    db,
    registry,
    executions,
    executionEvents,
    relayerTransactions,
  };
}
