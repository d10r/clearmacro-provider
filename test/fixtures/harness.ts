import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadRegistry } from "../../src/config/registry.js";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "../../src/db/repositories.js";
import type { OzRelayerClient } from "../../src/relayer/client.js";
import type { AppEnv } from "../../src/config/env.js";

export type HarnessOverrides = {
  apiAuthEnabled?: boolean;
  /** Required when `apiAuthEnabled` is true (unless you pass `env`). */
  apiClients?: AppEnv["apiClients"];
  env?: Pick<AppEnv, "apiAuthEnabled" | "apiClients">;
  providerName?: string;
  requestMaxMetadataKeys?: number;
  requestMaxMetadataValueLength?: number;
  relayerClient?: OzRelayerClient;
  getChainReadiness?: AppDeps["getChainReadiness"];
  getForwarderDigest?: AppDeps["getForwarderDigest"];
  validateRelaySignature?: AppDeps["validateRelaySignature"];
  preflightRunMacro?: AppDeps["preflightRunMacro"];
};

const defaultPreflightOk: NonNullable<AppDeps["preflightRunMacro"]> = async () => "ok";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function writeRegistryFixture(baseDir: string) {
  const registryPath = join(baseDir, "registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: ["http://localhost:8545"],
          allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
        },
      ],
    }),
  );
  return registryPath;
}

function createStubRelayerClient(): OzRelayerClient {
  return {
    ready: async () => true,
    listRelayerIds: async () => ["relayer-main"],
    getRelayer: async () => ({
      address: "0x00000000000000000000000000000000000000aa",
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
    submitTransaction: async () => {
      throw new Error("submitTransaction not stubbed for this test");
    },
    getTransaction: async () => {
      throw new Error("getTransaction not stubbed for this test");
    },
  } as unknown as OzRelayerClient;
}

export async function createTestHarness(overrides?: HarnessOverrides) {
  const dir = mkdtempSync(join(tmpdir(), "cm-harness-"));
  const registryPath = writeRegistryFixture(dir);
  const registry = loadRegistry(registryPath);
  registry.relayerIdByChainId.set(1, "relayer-main");
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const executions = new RelayExecutionRepository(db);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const createRequestAudit = new CreateRequestAuditLogRepository(db);

  const apiAuthEnabled = overrides?.env?.apiAuthEnabled ?? overrides?.apiAuthEnabled ?? false;
  const apiClients =
    overrides?.env?.apiClients ??
    overrides?.apiClients ??
    (apiAuthEnabled
      ? [{ id: "test-client", apiTokenHash: sha256Hex("test-token") }]
      : []);

  const built = await createApp({
    registry,
    executions,
    executionEvents,
    relayerTransactions,
    createRequestAudit,
    providerName: overrides?.providerName ?? "macros.superfluid.eth",
    relayerClient: overrides?.relayerClient ?? createStubRelayerClient(),
    env: overrides?.env ?? { apiAuthEnabled, apiClients },
    requestMaxMetadataKeys: overrides?.requestMaxMetadataKeys ?? 20,
    requestMaxMetadataValueLength: overrides?.requestMaxMetadataValueLength ?? 256,
    logLevel: "error",
    getChainReadiness: overrides?.getChainReadiness ?? (async () => ({ ready: true })),
    getForwarderDigest: overrides?.getForwarderDigest ?? (async () => `0x${"11".repeat(32)}`),
    validateRelaySignature: overrides?.validateRelaySignature ?? (async () => true),
    preflightRunMacro: overrides?.preflightRunMacro ?? defaultPreflightOk,
  });
  return {
    dir,
    app: built.app,
    db,
    registry,
    executions,
    executionEvents,
    relayerTransactions,
    createRequestAudit,
    sha256Hex,
    randomHex32: () => `0x${randomBytes(32).toString("hex")}` as const,
  };
}
