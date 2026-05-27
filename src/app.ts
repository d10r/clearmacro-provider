import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  registerRoutes,
  buildBearerResolver,
  type RegisterRoutesDeps,
} from "./api/routes.js";
import type { LoadedRegistry } from "./config/registry.js";
import type { AppEnv } from "./config/env.js";
import {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "./db/repositories.js";
import type { OzRelayerClient } from "./relayer/client.js";
import { createMetrics, type AppMetrics } from "./metrics/metrics.js";

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
  getReadyzChainReadiness: RegisterRoutesDeps["getReadyzChainReadiness"];
  getForwarderDigest: RegisterRoutesDeps["getForwarderDigest"];
  validateRelaySignature: RegisterRoutesDeps["validateRelaySignature"];
  preflightRunMacro?: RegisterRoutesDeps["preflightRunMacro"];
  metrics?: AppMetrics;
};

export async function createApp(deps: AppDeps) {
  const app = Fastify({ logger: { level: deps.logLevel } });
  const metrics = deps.metrics ?? createMetrics();

  await app.register(swagger, {
    openapi: {
      info: {
        title: "ClearMacro Provider API",
        version: "0.1.0",
        description:
          "HTTP API for submitting signed ClearMacro relay executions. Use `GET /v1/capabilities` to discover the configured provider name, forwarders, and per-chain macro admission policy, `POST /v1/relay-executions` to create an execution, then poll the returned execution `id` until it reaches a terminal state.",
      },
      servers: [
        {
          url: "https://clearmacro-provider.superfluid.dev",
          description: "Production",
        },
        {
          url: "http://localhost:3000",
          description: "Local development",
        },
      ],
      tags: [
        {
          name: "Health",
          description: "Process and dependency health checks.",
        },
        {
          name: "Relay Executions",
          description: "ClearMacro relay execution lifecycle.",
        },
        {
          name: "Capabilities",
          description: "Provider discovery for dapps before signing payloads.",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "Required when API authentication is enabled for the deployment.",
          },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get(
    "/metrics",
    {
      schema: {
        tags: ["Health"],
        summary: "Prometheus metrics",
        description: "Returns Prometheus-format application metrics.",
        response: {
          200: {
            type: "string",
            description: "Prometheus exposition format.",
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header("content-type", metrics.registry.contentType);
      return metrics.registry.metrics();
    },
  );

  const bearerResolver = deps.env.apiAuthEnabled
    ? buildBearerResolver(deps.env.apiClients)
    : () => null;

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
    getReadyzChainReadiness: deps.getReadyzChainReadiness,
    getForwarderDigest: deps.getForwarderDigest,
    validateRelaySignature: deps.validateRelaySignature,
    ...(deps.preflightRunMacro !== undefined
      ? { preflightRunMacro: deps.preflightRunMacro }
      : {}),
  });

  return { app, metrics };
}
