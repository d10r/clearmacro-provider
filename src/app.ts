import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerRoutes } from "./api/routes.js";
import type { LoadedRegistry } from "./config/registry.js";
import type { RelayRequestRepository, AuditEventRepository, RelayerTransactionRepository } from "./db/repositories.js";
import { createMetrics } from "./metrics/metrics.js";

export type AppDeps = {
  registry: LoadedRegistry;
  requests: RelayRequestRepository;
  audits: AuditEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  apiAuthEnabled: boolean;
  requestMaxMetadataKeys: number;
  requestMaxMetadataValueLength: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  getChainReadiness: (chainId: number) => Promise<{ ready: boolean; reasonCode?: "PROVIDER_NOT_READY" | "RELAYER_UNAVAILABLE" | "CONFIRMATION_MISMATCH" }>;
  getForwarderDigest: (input: { chainId: number; forwarder: string; macro: string; params: string }) => Promise<string>;
  validateRelaySignature: (input: { chainId: number; signer: string; digest: string; signature: string }) => Promise<boolean>;
};

export async function createApp(deps: AppDeps) {
  const app = Fastify({ logger: { level: deps.logLevel } });
  const metrics = createMetrics();

  await app.register(swagger, {
    openapi: {
      info: { title: "ClearMacro Provider API", version: "0.1.0" },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  await registerRoutes(app, {
    registry: deps.registry,
    requests: deps.requests,
    audits: deps.audits,
    relayerTransactions: deps.relayerTransactions,
    apiAuthEnabled: deps.apiAuthEnabled,
    requestMaxMetadataKeys: deps.requestMaxMetadataKeys,
    requestMaxMetadataValueLength: deps.requestMaxMetadataValueLength,
    getChainReadiness: deps.getChainReadiness,
    getForwarderDigest: deps.getForwarderDigest,
    validateRelaySignature: deps.validateRelaySignature,
  });

  return { app, metrics };
}

