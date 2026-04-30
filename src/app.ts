import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerRoutes, buildBearerResolver, type RegisterRoutesDeps } from "./api/routes.js";
import type { LoadedRegistry } from "./config/registry.js";
import type { AppEnv } from "./config/env.js";
import {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "./db/repositories.js";
import type { OzRelayerClient } from "./relayer/client.js";
import { createMetrics } from "./metrics/metrics.js";

export type AppDeps = {
  registry: LoadedRegistry;
  executions: RelayExecutionRepository;
  executionEvents: RelayExecutionEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  createRequestAudit: CreateRequestAuditLogRepository;
  providerName: string;
  relayerClient: OzRelayerClient;
  env: Pick<AppEnv, "apiAuthEnabled" | "apiClients">;
  requestMaxMetadataKeys: number;
  requestMaxMetadataValueLength: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  getChainReadiness: RegisterRoutesDeps["getChainReadiness"];
  getForwarderDigest: RegisterRoutesDeps["getForwarderDigest"];
  validateRelaySignature: RegisterRoutesDeps["validateRelaySignature"];
  preflightRunMacro?: RegisterRoutesDeps["preflightRunMacro"];
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

  const bearerResolver = deps.env.apiAuthEnabled ? buildBearerResolver(deps.env.apiClients) : () => null;

  await registerRoutes(app, {
    registry: deps.registry,
    executions: deps.executions,
    executionEvents: deps.executionEvents,
    relayerTransactions: deps.relayerTransactions,
    createRequestAudit: deps.createRequestAudit,
    providerName: deps.providerName,
    relayerClient: deps.relayerClient,
    apiAuthEnabled: deps.env.apiAuthEnabled,
    resolveClientIdFromBearer: bearerResolver,
    requestMaxMetadataKeys: deps.requestMaxMetadataKeys,
    requestMaxMetadataValueLength: deps.requestMaxMetadataValueLength,
    getChainReadiness: deps.getChainReadiness,
    getForwarderDigest: deps.getForwarderDigest,
    validateRelaySignature: deps.validateRelaySignature,
    ...(deps.preflightRunMacro !== undefined ? { preflightRunMacro: deps.preflightRunMacro } : {}),
  });

  return { app, metrics };
}
