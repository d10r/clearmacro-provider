import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import {
  CapabilitiesResponseSchema,
  CreateRelayExecutionRequestSchema,
  ErrorBodySchema,
  HealthzResponseSchema,
  ReadyzResponseSchema,
  RelayExecutionEventsResponseSchema,
  RelayExecutionResponseSchema,
} from "./schemas.js";
import { ApiError, toErrorBody } from "./errors.js";
import type { RegisterRoutesDeps } from "./deps.js";
import type { RelayerTransactionRepository } from "../db/repositories.js";
import type { RelayExecutionRow } from "../db/repositories.js";
import {
  admitRelayExecution,
  finalizeCreatedExecution,
  type CreateRelayExecutionBody,
} from "./admitRelayExecution.js";
import { cancelRelayExecution } from "./cancelRelayExecution.js";
import { buildSafeMessageLink } from "../safe/config.js";

export type { RegisterRoutesDeps } from "./deps.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveRequestClientId(
  deps: RegisterRoutesDeps,
  authorizationHeader: string | undefined,
): string {
  if (!deps.apiAuthEnabled) {
    return "anonymous";
  }
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHORIZED", "Missing bearer token.", "auth", false);
  }
  const resolved = deps.resolveClientIdFromBearer(authorizationHeader.slice("Bearer ".length));
  if (!resolved) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid API token.", "auth", false);
  }
  return resolved;
}

function assertKindExclusiveRelayFields(body: Record<string, unknown>): void {
  if (body.kind === "clearMacroV1") {
    const hasSignature = body.signature !== undefined;
    const hasAuthorization = body.authorization !== undefined;
    if (hasSignature === hasAuthorization) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "clearMacroV1 requests require exactly one of signature or authorization.",
        "validation",
        false,
      );
    }
    if (body.permit2 !== undefined) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "clearMacroV1 requests must not include permit2.",
        "validation",
        false,
      );
    }
    if (hasAuthorization) {
      const authorization = body.authorization as { type?: string; safeMessageHash?: string } | undefined;
      if (authorization?.type !== "safeMessageV1" || !authorization.safeMessageHash) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "clearMacroV1 authorization must be safeMessageV1 with safeMessageHash.",
          "validation",
          false,
        );
      }
      if (body.forceExecuteAfterPreflightRevert === true) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Safe message authorization does not support forceExecuteAfterPreflightRevert.",
          "validation",
          false,
        );
      }
    }
    return;
  }
  if (body.kind === "clearMacroPermit2V1") {
    if (body.signature !== undefined) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "clearMacroPermit2V1 requests must not include top-level signature.",
        "validation",
        false,
      );
    }
    if (body.authorization !== undefined) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "clearMacroPermit2V1 requests must not include authorization.",
        "validation",
        false,
      );
    }
  }
}

function toRelayExecutionResponse(
  row: RelayExecutionRow,
  relayer: ReturnType<RelayerTransactionRepository["getByExecutionId"]>,
  deps?: Pick<RegisterRoutesDeps, "safeClient" | "safeAuthorizationEnabled">,
) {
  const receipt = row.receiptJson
    ? (JSON.parse(
        row.receiptJson,
      ) as RelayExecutionRow["receiptJson"] extends string ? never : never)
    : undefined;
  const error = row.lastErrorJson
    ? (JSON.parse(row.lastErrorJson) as {
        code: string;
        message: string;
        category: "user" | "provider" | "chain" | "relayer" | "unknown";
        retryable: boolean;
      })
    : undefined;
  const transaction =
    row.currentTransactionHash !== null
      ? {
          hash: row.currentTransactionHash as `0x${string}`,
          to: row.forwarderAddress as `0x${string}`,
          submittedAt: relayer?.submittedAt ?? undefined,
        }
      : undefined;
  const authorization =
    row.authorizationType === "safeMessageV1" && row.safeMessageHash
      ? {
          type: "safeMessageV1" as const,
          safeMessageHash: row.safeMessageHash as `0x${string}`,
          ...(deps?.safeAuthorizationEnabled
            ? {
                messageLink:
                  buildSafeMessageLink({
                    chainId: row.chainId,
                    safeAddress: row.signerAddress,
                    safeMessageHash: row.safeMessageHash,
                  }) ?? undefined,
              }
            : {}),
        }
      : undefined;
  return {
    id: row.id,
    state: row.state,
    terminal: row.terminal === 1,
    kind: row.kind as "clearMacroV1" | "clearMacroPermit2V1",
    chainId: row.chainId,
    clientRequestId: row.clientRequestId ?? undefined,
    metadata: JSON.parse(row.metadataJson) as Record<string, string>,
    forwarderAddress: row.forwarderAddress as `0x${string}`,
    macroAddress: row.macroAddress as `0x${string}`,
    signerAddress: row.signerAddress as `0x${string}`,
    nonce: row.nonce,
    validity: {
      validAfter: row.validAfter,
      validBefore: row.validBefore,
    },
    value: row.value,
    ...(transaction ? { transaction } : {}),
    ...(receipt
      ? {
          receipt: receipt as {
            transactionHash: `0x${string}`;
            blockNumber: string;
            blockHash?: `0x${string}`;
            status: "success" | "reverted";
            gasUsed?: string;
          },
        }
      : {}),
    ...(error ? { error } : {}),
    ...(authorization ? { authorization } : {}),
    timestamps: {
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      terminalAt: row.terminalAt ?? undefined,
    },
    links: {
      self: `/v1/relay-executions/${row.id}`,
    },
  };
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: RegisterRoutesDeps,
): Promise<void> {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send(toErrorBody(error));
      return;
    }
    const maybeFastifyError = error as {
      validation?: unknown;
      code?: string;
      statusCode?: number;
    };
    if (
      maybeFastifyError.validation !== undefined ||
      maybeFastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      reply
        .status(400)
        .send(
          toErrorBody(
            new ApiError(
              400,
              "VALIDATION_ERROR",
              "Request validation failed.",
              "validation",
              false,
            ),
          ),
        );
      return;
    }
    app.log.error({ err: error }, "Unhandled API error");
    reply
      .status(500)
      .send(
        toErrorBody(
          new ApiError(
            500,
            "INTERNAL_ERROR",
            "Unexpected server error",
            "unknown",
            false,
          ),
        ),
      );
  });

  app.get(
    "/healthz",
    {
      schema: {
        tags: ["Health"],
        summary: "Liveness check",
        description:
          "Returns `200` when the HTTP process is running. This does not verify chain RPCs or OpenZeppelin Relayer readiness.",
        response: {
          200: { ...HealthzResponseSchema, description: "Process is alive." },
        },
      },
    },
    async () => ({ ok: true }),
  );
  app.get(
    "/readyz",
    {
      schema: {
        tags: ["Health"],
        summary: "Readiness check",
        description:
          "Checks all configured chains for provider readiness. This includes app RPC access, OpenZeppelin Relayer availability, relayer binding, and signer balance. Returns `503` when any chain is not ready.",
        response: {
          200: {
            ...ReadyzResponseSchema,
            description: "All configured chains are ready.",
          },
          503: {
            ...ReadyzResponseSchema,
            description: "At least one configured chain is not ready.",
          },
        },
      },
    },
    async (_request, reply) => {
      const chains = deps.registry.raw.chains;
      const checks = await Promise.all(
        chains.map(async (chain) => ({
          chainId: chain.chainId,
          result: await deps.getReadyzChainReadiness(chain.chainId),
        })),
      );
      const allReady = checks.every((check) => check.result.ready);
      if (!allReady) {
        reply.code(503);
      }
      return {
        ready: allReady,
        chains: checks.map((check) => ({
          chainId: check.chainId,
          ready: check.result.ready,
          reasonCode: check.result.reasonCode ?? null,
        })),
      };
    },
  );

  app.post(
    "/v1/relay-executions",
    {
      schema: {
        tags: ["Relay Executions"],
        summary: "Create a relay execution",
        description:
          "Validates a signed ClearMacro payload, performs readiness and preflight checks, and persists a `pending` relay execution. The worker submits the transaction to OpenZeppelin Relayer after creation. Exact signed authorization retries are deduplicated by `(chainId, forwarderAddress, signerAddress, digest)`.",
        security: [{ bearerAuth: [] }],
        body: CreateRelayExecutionRequestSchema,
        response: {
          200: {
            ...RelayExecutionResponseSchema,
            description:
              "Existing execution for the same signed authorization intent.",
          },
          202: {
            ...RelayExecutionResponseSchema,
            description:
              "New execution accepted and queued for worker submission.",
          },
          400: {
            ...ErrorBodySchema,
            description: "Malformed request or unsupported request shape.",
          },
          401: {
            ...ErrorBodySchema,
            description:
              "Missing or invalid bearer token when API authentication is enabled.",
          },
          403: {
            ...ErrorBodySchema,
            description:
              "Configured chain, macro, or provider policy rejected the request.",
          },
          409: {
            ...ErrorBodySchema,
            description:
              "A duplicate execution exists but is not visible to this authenticated client.",
          },
          422: {
            ...ErrorBodySchema,
            description:
              "Payload, signature, validity window, or preflight validation failed.",
          },
          503: {
            ...ErrorBodySchema,
            description: "Provider, relayer, or chain dependency is not ready.",
          },
        },
      },
    },
    async (request, reply) => {
      assertKindExclusiveRelayFields(request.body as Record<string, unknown>);
      const body = request.body as CreateRelayExecutionBody;
      const clientId = resolveRequestClientId(deps, request.headers.authorization);

      const result = await admitRelayExecution(deps, body, clientId);
      if ("error" in result) {
        throw result.error;
      }

      const row = finalizeCreatedExecution(deps, result.row);
      reply.code(result.statusCode);
      return toRelayExecutionResponse(
        row,
        deps.relayerTransactions.getByExecutionId(row.id),
        deps,
      );
    },
  );

  app.get(
    "/v1/relay-executions/:id",
    {
      schema: {
        tags: ["Relay Executions"],
        summary: "Get a relay execution",
        description:
          "Returns the public execution resource. Dapps should poll this endpoint by provider execution `id` until `terminal` is true. The transaction hash is optional metadata and may be absent until the state becomes `submitted`.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: {
              type: "string",
              description: "Provider execution ID returned by create.",
            },
          },
        },
        querystring: {
          type: "object",
          properties: {
            include: {
              type: "string",
              enum: ["events"],
              description:
                "Set to `events` to include sanitized lifecycle events.",
            },
          },
        },
        response: {
          200: {
            ...RelayExecutionEventsResponseSchema,
            description: "Execution resource.",
          },
          404: {
            ...ErrorBodySchema,
            description: "No execution exists for the requested ID.",
          },
        },
      },
    },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const row = deps.executions.getById(id);
      if (!row) {
        throw new ApiError(
          404,
          "EXECUTION_NOT_FOUND",
          "Relay execution not found.",
          "validation",
          false,
        );
      }
      const includeEvents =
        (request.query as { include?: string }).include === "events";
      const relayer = deps.relayerTransactions.getByExecutionId(id);
      const response = toRelayExecutionResponse(row, relayer, deps);
      if (!includeEvents) {
        return response;
      }
      return {
        ...response,
        events: deps.executionEvents.listByExecution(id),
      };
    },
  );

  app.delete(
    "/v1/relay-executions/:id",
    {
      schema: {
        tags: ["Relay Executions"],
        summary: "Cancel a relay execution",
        description:
          "Cancels an execution that is still `awaiting_authorization`, or `pending` before OpenZeppelin Relayer submission. Idempotent when already `canceled`. Does not cancel in-flight relayer transactions (`submitted` / pending with a relayer id). When API auth is enabled, only the creating client may cancel.",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: {
              type: "string",
              description: "Provider execution ID returned by create.",
            },
          },
        },
        response: {
          200: {
            ...RelayExecutionResponseSchema,
            description: "Execution canceled (or already canceled).",
          },
          401: {
            ...ErrorBodySchema,
            description:
              "Missing or invalid bearer token when API authentication is enabled.",
          },
          404: {
            ...ErrorBodySchema,
            description: "No execution exists for the requested ID (or not visible to this client).",
          },
          409: {
            ...ErrorBodySchema,
            description: "Execution is no longer cancelable.",
          },
        },
      },
    },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const clientId = resolveRequestClientId(deps, request.headers.authorization);
      const row = cancelRelayExecution(deps, {
        executionId: id,
        clientId,
        apiAuthEnabled: deps.apiAuthEnabled,
      });
      return toRelayExecutionResponse(
        row,
        deps.relayerTransactions.getByExecutionId(row.id),
        deps,
      );
    },
  );

  app.get(
    "/v1/capabilities",
    {
      schema: {
        tags: ["Capabilities"],
        summary: "Get provider capabilities",
        description:
          "Returns the deployment-wide provider name, configured chain forwarders, and per-chain macro admission policy. Dapps should call this before signing so `payload.security.provider` and the ClearMacro forwarder match this provider. Readiness, relayer IDs, and relayer status are not exposed.",
        response: {
          200: {
            ...CapabilitiesResponseSchema,
            description:
              "Provider name, chain forwarders, and macro admission policy (informational; enforcement is on create).",
          },
        },
      },
    },
    async () => ({
      providerName: deps.providerName,
      chains: deps.registry.raw.chains.map((chain) => ({
        chainId: chain.chainId,
        forwarderAddress: chain.forwarderAddress as `0x${string}`,
        supportedKinds: ["clearMacroV1", "clearMacroPermit2V1"] as const,
        supportedAuthorizationMethods: [
          "signature",
          ...(deps.safeAuthorizationEnabled &&
          deps.safeClient?.isChainSupported(chain.chainId)
            ? (["safeMessageV1"] as const)
            : []),
        ],
        macroPolicy: chain.macroPolicy,
      })),
    }),
  );
}

export function buildBearerResolver(
  apiClients: { apiTokenHash: string; id: string }[],
): (rawToken: string) => string | null {
  const map = new Map(
    apiClients.map((c) => [c.apiTokenHash.toLowerCase(), c.id]),
  );
  return (rawToken: string) => {
    const hash = sha256(rawToken).toLowerCase();
    return map.get(hash) ?? null;
  };
}
