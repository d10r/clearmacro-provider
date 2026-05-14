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
import type { LoadedRegistry } from "../config/registry.js";
import { decodeClearMacroPayload } from "../validation/clearmacro.js";
import { assertMacroAllowed } from "../validation/registry.js";
import type {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayExecutionRow,
  RelayerTransactionRepository,
} from "../db/repositories.js";
import { projectRelayerState } from "../relayer/mapper.js";
import type { OzRelayerClient } from "../relayer/client.js";
import { hashCanonicalCreateBody } from "./canonicalBody.js";
import {
  preflightRunMacro,
  type ChainReadinessResult,
} from "../chain/readiness.js";
import type { RegistryChain } from "../config/schema.js";

export type RegisterRoutesDeps = {
  registry: LoadedRegistry;
  executions: RelayExecutionRepository;
  executionEvents: RelayExecutionEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  createRequestAudit: CreateRequestAuditLogRepository;
  providerName: string;
  relayerClient: OzRelayerClient;
  apiAuthEnabled: boolean;
  resolveClientIdFromBearer: (bearerToken: string) => string | null;
  requestMaxMetadataKeys: number;
  requestMaxMetadataValueLength: number;
  getChainReadiness: (chainId: number) => Promise<ChainReadinessResult>;
  getReadyzChainReadiness: (chainId: number) => Promise<ChainReadinessResult>;
  getForwarderDigest: (input: {
    chainId: number;
    forwarder: string;
    macro: string;
    params: string;
  }) => Promise<string>;
  validateRelaySignature: (input: {
    chainId: number;
    signer: string;
    digest: string;
    signature: string;
  }) => Promise<boolean>;
  /** Test override hook; defaults to real `preflightRunMacro`. */
  preflightRunMacro?: (input: {
    chain: RegistryChain;
    forwarder: string;
    macro: string;
    params: string;
    signer: string;
    relayerSigner: string;
    signature: string;
    msgValue: string;
  }) => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toRelayExecutionResponse(
  row: RelayExecutionRow,
  relayer: ReturnType<RelayerTransactionRepository["getByExecutionId"]>,
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
  return {
    id: row.id,
    state: row.state,
    terminal: row.terminal === 1,
    kind: "clearMacroV1" as const,
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

function isSqliteUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("SQLITE_CONSTRAINT") ||
    message.includes("UNIQUE constraint failed")
  );
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: RegisterRoutesDeps,
): Promise<void> {
  const preflight = deps.preflightRunMacro ?? preflightRunMacro;

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
      const body = request.body as {
        kind: "clearMacroV1";
        chainId: number;
        macroAddress: string;
        signerAddress: string;
        payload: string;
        signature: string;
        value?: string;
        forceExecuteAfterPreflightRevert?: boolean;
        clientRequestId?: string;
        metadata?: Record<string, string>;
      };

      const clientId = deps.apiAuthEnabled
        ? (() => {
            const authHeader = request.headers.authorization;
            if (!authHeader?.startsWith("Bearer ")) {
              throw new ApiError(
                401,
                "UNAUTHORIZED",
                "Missing bearer token.",
                "auth",
                false,
              );
            }
            const token = authHeader.slice("Bearer ".length);
            const resolved = deps.resolveClientIdFromBearer(token);
            if (!resolved) {
              throw new ApiError(
                401,
                "UNAUTHORIZED",
                "Invalid API token.",
                "auth",
                false,
              );
            }
            return resolved;
          })()
        : "anonymous";

      const requestBodyHash = hashCanonicalCreateBody({
        kind: body.kind,
        chainId: body.chainId,
        macroAddress: body.macroAddress,
        signerAddress: body.signerAddress,
        payload: body.payload,
        signature: body.signature,
        value: body.value ?? "0",
        forceExecuteAfterPreflightRevert:
          body.forceExecuteAfterPreflightRevert ?? false,
        clientRequestId: body.clientRequestId ?? null,
        metadata: body.metadata ?? {},
      });

      const auditBase = {
        clientId,
        requestBodyHash,
        chainId: body.chainId as number | null,
        kind: body.kind as string | null,
        forwarderAddress: null as string | null,
        domain: null as string | null,
        macroAddress: body.macroAddress.toLowerCase(),
        signerAddress: body.signerAddress.toLowerCase(),
        providerName: deps.providerName,
        nonce: null as string | null,
        digest: null as string | null,
      };

      if (body.kind !== "clearMacroV1") {
        throw new ApiError(
          400,
          "UNSUPPORTED_RELAY_KIND",
          "Only clearMacroV1 is enabled in v1.",
          "validation",
          false,
        );
      }

      const chainConfig = deps.registry.chainsById.get(body.chainId);
      if (!chainConfig) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "CHAIN_NOT_ALLOWED",
          executionId: null,
          chainId: body.chainId,
        });
        throw new ApiError(
          403,
          "CHAIN_NOT_ALLOWED",
          "Unsupported chain.",
          "validation",
          false,
        );
      }
      const forwarderAddress = chainConfig.forwarderAddress;
      auditBase.forwarderAddress = forwarderAddress;

      const metadata = { ...(body.metadata ?? {}) };
      if (Object.keys(metadata).length > deps.requestMaxMetadataKeys) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "VALIDATION_ERROR",
          executionId: null,
        });
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Too many metadata keys.",
          "validation",
          false,
        );
      }
      for (const value of Object.values(metadata)) {
        if (value.length > deps.requestMaxMetadataValueLength) {
          deps.createRequestAudit.append({
            ...auditBase,
            outcomeCode: "VALIDATION_ERROR",
            executionId: null,
          });
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Metadata value too long.",
            "validation",
            false,
          );
        }
      }

      let decoded;
      try {
        decoded = decodeClearMacroPayload(body.payload);
      } catch {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "INVALID_CLEAR_MACRO_PAYLOAD",
          executionId: null,
        });
        throw new ApiError(
          422,
          "INVALID_CLEAR_MACRO_PAYLOAD",
          "Payload is not valid ABI-encoded clear macro payload.",
          "user",
          false,
        );
      }
      auditBase.domain = decoded.domain;
      auditBase.nonce = decoded.nonce.toString();
      if (decoded.macroContract !== body.macroAddress.toLowerCase()) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "INVALID_CLEAR_MACRO_PAYLOAD",
          executionId: null,
        });
        throw new ApiError(
          422,
          "INVALID_CLEAR_MACRO_PAYLOAD",
          "Macro mismatch in payload.",
          "user",
          false,
        );
      }
      if (decoded.provider !== deps.providerName) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "PROVIDER_NOT_ALLOWED",
          executionId: null,
        });
        throw new ApiError(
          403,
          "PROVIDER_NOT_ALLOWED",
          "Payload provider does not match deployment provider name.",
          "validation",
          false,
        );
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      if (decoded.validBefore !== 0n && decoded.validBefore <= now) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "CLEAR_MACRO_EXPIRED",
          executionId: null,
        });
        throw new ApiError(
          422,
          "CLEAR_MACRO_EXPIRED",
          "Request has expired.",
          "user",
          false,
        );
      }
      if (decoded.validAfter > now) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "CLEAR_MACRO_NOT_YET_VALID",
          executionId: null,
        });
        throw new ApiError(
          422,
          "CLEAR_MACRO_NOT_YET_VALID",
          "Request is not valid yet.",
          "user",
          true,
        );
      }

      const macroPolicy = assertMacroAllowed(deps.registry, {
        chainId: body.chainId,
        domain: decoded.domain,
        macroAddress: body.macroAddress,
      });
      if (!macroPolicy.ok) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "MACRO_NOT_ALLOWED",
          executionId: null,
        });
        throw new ApiError(
          403,
          macroPolicy.code,
          macroPolicy.message,
          "validation",
          false,
        );
      }

      const readiness = await deps.getChainReadiness(body.chainId);
      if (!readiness.ready) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "READINESS_UNAVAILABLE",
          executionId: null,
        });
        const category =
          readiness.reasonCode === "RELAYER_RATE_LIMITED"
            ? "relayer"
            : "provider";
        throw new ApiError(
          503,
          readiness.reasonCode ?? "PROVIDER_NOT_READY",
          "Requested chain is not ready.",
          category,
          true,
        );
      }

      let digest: string;
      try {
        digest = await deps.getForwarderDigest({
          chainId: body.chainId,
          forwarder: forwarderAddress,
          macro: body.macroAddress.toLowerCase(),
          params: body.payload,
        });
      } catch {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "CHAIN_UNAVAILABLE",
          executionId: null,
          digest: null,
        });
        throw new ApiError(
          503,
          "CHAIN_UNAVAILABLE",
          "Unable to read ClearMacro digest from app RPCs.",
          "chain",
          true,
        );
      }
      auditBase.digest = digest;

      const existingByDigest = deps.executions.findByDedupKey(
        body.chainId,
        forwarderAddress,
        body.signerAddress.toLowerCase(),
        digest,
      );
      if (existingByDigest) {
        if (existingByDigest.clientId === clientId) {
          deps.createRequestAudit.append({
            ...auditBase,
            outcomeCode: "DUPLICATE_REPLAYED",
            executionId: existingByDigest.id,
            digest,
          });
          reply.code(200);
          return toRelayExecutionResponse(
            existingByDigest,
            deps.relayerTransactions.getByExecutionId(existingByDigest.id),
          );
        }
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "DUPLICATE_HIDDEN",
          executionId: null,
          digest,
        });
        throw new ApiError(
          409,
          "DUPLICATE_EXECUTION",
          "A matching execution already exists for another caller.",
          "validation",
          false,
          null,
        );
      }

      let validSignature: boolean;
      try {
        validSignature = await deps.validateRelaySignature({
          chainId: body.chainId,
          signer: body.signerAddress.toLowerCase(),
          digest,
          signature: body.signature,
        });
      } catch {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "CHAIN_UNAVAILABLE",
          executionId: null,
          digest,
        });
        throw new ApiError(
          503,
          "CHAIN_UNAVAILABLE",
          "Unable to validate signature with app RPCs.",
          "chain",
          true,
        );
      }
      if (!validSignature) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "SIGNATURE_INVALID",
          executionId: null,
          digest,
        });
        throw new ApiError(
          422,
          "SIGNATURE_INVALID",
          "Signature validation failed for digest and signer.",
          "user",
          false,
        );
      }

      const ozRelayerId = deps.registry.relayerIdByChainId.get(body.chainId);
      if (!ozRelayerId) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "READINESS_UNAVAILABLE",
          executionId: null,
          digest,
        });
        throw new ApiError(
          503,
          "RELAYER_UNAVAILABLE",
          "Relayer is not bound for this chain.",
          "relayer",
          true,
        );
      }

      let relayerSigner: string;
      try {
        const relayerDetails = await deps.relayerClient.getRelayer(ozRelayerId);
        relayerSigner = relayerDetails.address;
      } catch {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "READINESS_UNAVAILABLE",
          executionId: null,
          digest,
        });
        throw new ApiError(
          503,
          "RELAYER_UNAVAILABLE",
          "Unable to load relayer signer for preflight.",
          "relayer",
          true,
        );
      }

      const preflightResult = await preflight({
        chain: chainConfig,
        forwarder: forwarderAddress,
        macro: body.macroAddress.toLowerCase(),
        params: body.payload,
        signer: body.signerAddress.toLowerCase(),
        relayerSigner,
        signature: body.signature,
        msgValue: body.value ?? "0",
      });
      if (preflightResult === "rpc_unavailable") {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "CHAIN_UNAVAILABLE",
          executionId: null,
          digest,
        });
        throw new ApiError(
          503,
          "CHAIN_UNAVAILABLE",
          "Unable to run preflight simulation on app RPCs.",
          "chain",
          true,
        );
      }
      const forceRequested = body.forceExecuteAfterPreflightRevert === true;
      if (preflightResult === "deterministic_revert" && !forceRequested) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "PREFLIGHT_REVERTED",
          executionId: null,
          digest,
        });
        throw new ApiError(
          422,
          "PREFLIGHT_REVERTED",
          "Preflight simulation predicts revert.",
          "user",
          false,
        );
      }
      if (preflightResult === "deterministic_revert" && forceRequested) {
        metadata.forceSubmittedAfterPreflightRevert = "true";
      }

      const requiredConfirmations =
        deps.registry.requiredConfirmationsByChainId.get(body.chainId);
      if (requiredConfirmations === undefined) {
        deps.createRequestAudit.append({
          ...auditBase,
          outcomeCode: "READINESS_UNAVAILABLE",
          executionId: null,
          digest,
        });
        throw new ApiError(
          503,
          "RELAYER_UNAVAILABLE",
          "Relayer finality policy is not bound for this chain.",
          "relayer",
          true,
        );
      }

      const forceAfterPreflightRevert =
        preflightResult === "deterministic_revert" && forceRequested ? 1 : 0;

      let inserted: RelayExecutionRow;
      try {
        inserted = deps.executions.createPending({
          clientId,
          clientRequestId: body.clientRequestId ?? null,
          requestBodyHash,
          digest,
          domain: decoded.domain,
          kind: body.kind,
          chainId: body.chainId,
          ozRelayerId,
          forwarderAddress,
          macroAddress: body.macroAddress.toLowerCase(),
          signerAddress: body.signerAddress.toLowerCase(),
          nonce: decoded.nonce.toString(),
          validAfter: decoded.validAfter.toString(),
          validBefore: decoded.validBefore.toString(),
          value: body.value ?? "0",
          payload: body.payload,
          signature: body.signature,
          permit2Json: null,
          metadataJson: JSON.stringify(metadata),
          forceAfterPreflightRevert,
          requiredConfirmations,
        });
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          const raced = deps.executions.findByDedupKey(
            body.chainId,
            forwarderAddress,
            body.signerAddress.toLowerCase(),
            digest,
          );
          if (raced) {
            if (raced.clientId === clientId) {
              deps.createRequestAudit.append({
                ...auditBase,
                outcomeCode: "DUPLICATE_REPLAYED",
                executionId: raced.id,
                digest,
              });
              reply.code(200);
              return toRelayExecutionResponse(
                raced,
                deps.relayerTransactions.getByExecutionId(raced.id),
              );
            }
            deps.createRequestAudit.append({
              ...auditBase,
              outcomeCode: "DUPLICATE_HIDDEN",
              executionId: null,
              digest,
            });
            throw new ApiError(
              409,
              "DUPLICATE_EXECUTION",
              "A matching execution already exists for another caller.",
              "validation",
              false,
              null,
            );
          }
        }
        throw error;
      }

      deps.createRequestAudit.append({
        ...auditBase,
        outcomeCode: "CREATED",
        executionId: inserted.id,
        digest,
      });

      deps.executionEvents.append({
        executionId: inserted.id,
        type: "state_changed",
        actor: "api",
        reason: "Execution created after synchronous validation",
        detailsJson: JSON.stringify({
          chainId: inserted.chainId,
          kind: inserted.kind,
        }),
      });

      const relayer = deps.relayerTransactions.getByExecutionId(inserted.id);
      if (relayer) {
        const projection = projectRelayerState({
          status: relayer.status,
          statusReason: relayer.statusReason,
          hash: relayer.txHash,
          confirmedAt: relayer.confirmedAt,
          receipt: inserted.receiptJson
            ? JSON.parse(inserted.receiptJson)
            : null,
          requiredConfirmations: inserted.requiredConfirmations,
        });
        if (projection.state !== inserted.state) {
          inserted = deps.executions.transitionState(
            inserted.id,
            projection.state,
          );
        }
      }
      reply.code(202);
      return toRelayExecutionResponse(inserted, relayer);
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
      const response = toRelayExecutionResponse(row, relayer);
      if (!includeEvents) {
        return response;
      }
      return {
        ...response,
        events: deps.executionEvents.listByExecution(id),
      };
    },
  );

  app.get(
    "/v1/capabilities",
    {
      schema: {
        tags: ["Capabilities"],
        summary: "Get provider capabilities",
        description:
          "Returns the deployment-wide provider name and configured chain forwarders. Dapps should call this before signing so `payload.security.provider` and the ClearMacro forwarder match this provider. Macro policy, readiness, relayer IDs, and relayer status are intentionally not exposed.",
        response: {
          200: {
            ...CapabilitiesResponseSchema,
            description: "Provider name and configured chain forwarders.",
          },
        },
      },
    },
    async () => ({
      providerName: deps.providerName,
      chains: deps.registry.raw.chains.map((chain) => ({
        chainId: chain.chainId,
        forwarderAddress: chain.forwarderAddress as `0x${string}`,
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
