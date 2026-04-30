import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { CreateRelayExecutionRequestSchema, ErrorBodySchema, RelayExecutionEventsResponseSchema, RelayExecutionResponseSchema } from "./schemas.js";
import { ApiError, toErrorBody } from "./errors.js";
import type { LoadedRegistry } from "../config/registry.js";
import { decodeClearMacroPayload } from "../validation/clearmacro.js";
import { validateRegistryPolicy } from "../validation/registry.js";
import type { RelayExecutionRepository, RelayExecutionEventRepository, RelayerTransactionRepository, RelayExecutionRow } from "../db/repositories.js";
import { projectRelayerState } from "../relayer/mapper.js";

type RegisterRoutesDeps = {
  registry: LoadedRegistry;
  executions: RelayExecutionRepository;
  executionEvents: RelayExecutionEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  apiAuthEnabled: boolean;
  requestMaxMetadataKeys: number;
  requestMaxMetadataValueLength: number;
  getChainReadiness: (chainId: number) => Promise<{ ready: boolean; reasonCode?: "PROVIDER_NOT_READY" | "RELAYER_UNAVAILABLE" | "CONFIRMATION_MISMATCH" }>;
  getForwarderDigest: (input: { chainId: number; forwarder: string; macro: string; params: string }) => Promise<string>;
  validateRelaySignature: (input: { chainId: number; signer: string; digest: string; signature: string }) => Promise<boolean>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeCreateBody(body: {
  chainId: number;
  macroAddress: string;
  signerAddress: string;
  payload: string;
  signature: string;
  value?: string;
  clientRequestId?: string;
  metadata?: Record<string, string>;
}): string {
  return JSON.stringify({
    kind: "clearMacroV1",
    chainId: body.chainId,
    macroAddress: body.macroAddress.toLowerCase(),
    signerAddress: body.signerAddress.toLowerCase(),
    payload: body.payload,
    signature: body.signature,
    value: body.value ?? "0",
    clientRequestId: body.clientRequestId ?? null,
    metadata: Object.fromEntries(Object.entries(body.metadata ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  });
}

function toRelayExecutionResponse(row: RelayExecutionRow, relayer: ReturnType<RelayerTransactionRepository["getByExecutionId"]>) {
  const hashes = JSON.parse(row.transactionHashesJson) as `0x${string}`[];
  const receipt = row.receiptJson ? (JSON.parse(row.receiptJson) as RelayExecutionRow["receiptJson"] extends string ? never : never) : undefined;
  const error = row.lastErrorJson ? (JSON.parse(row.lastErrorJson) as { code: string; message: string; category: "user" | "provider" | "chain" | "relayer" | "unknown"; retryable: boolean }) : undefined;
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
    provider: row.provider,
    nonce: row.nonce,
    validity: {
      validAfter: row.validAfter,
      validBefore: row.validBefore,
    },
    value: row.value,
    transaction: {
      hash: row.currentTransactionHash ?? undefined,
      hashes,
      from: undefined,
      to: row.forwarderAddress as `0x${string}`,
      nonce: relayer?.nonce ?? undefined,
      gasLimit: relayer?.gasLimit ?? undefined,
      gasPrice: relayer?.gasPrice ?? undefined,
      maxFeePerGas: relayer?.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: relayer?.maxPriorityFeePerGas ?? undefined,
      submittedAt: relayer?.submittedAt ?? undefined,
      includedAt: relayer?.includedAt ?? undefined,
      confirmedAt: relayer?.confirmedAt ?? undefined,
    },
    receipt: receipt as {
      transactionHash: `0x${string}`;
      blockNumber: string;
      blockHash?: `0x${string}`;
      status: "success" | "reverted";
      gasUsed?: string;
    } | undefined,
    error,
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

export async function registerRoutes(app: FastifyInstance, deps: RegisterRoutesDeps): Promise<void> {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send(toErrorBody(error));
      return;
    }
    const maybeFastifyError = error as { validation?: unknown; code?: string; statusCode?: number };
    if (
      maybeFastifyError.validation !== undefined ||
      maybeFastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      reply.status(400).send(toErrorBody(new ApiError(400, "VALIDATION_ERROR", "Request validation failed.", "validation", false)));
      return;
    }
    app.log.error({ err: error }, "Unhandled API error");
    reply.status(500).send(toErrorBody(new ApiError(500, "INTERNAL_ERROR", "Unexpected server error", "unknown", false)));
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    const enabledChains = deps.registry.raw.chains.filter((chain) => chain.enabled);
    const checks = await Promise.all(
      enabledChains.map(async (chain) => ({
        chainId: chain.chainId,
        result: await deps.getChainReadiness(chain.chainId),
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
  });

  app.post(
    "/v1/relay-executions",
    {
      schema: {
        body: CreateRelayExecutionRequestSchema,
        response: {
          200: RelayExecutionResponseSchema,
          202: RelayExecutionResponseSchema,
          400: ErrorBodySchema,
          401: ErrorBodySchema,
          403: ErrorBodySchema,
          409: ErrorBodySchema,
          422: ErrorBodySchema,
          503: ErrorBodySchema,
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
        clientRequestId?: string;
        metadata?: Record<string, string>;
      };
      const requestBodyHash = sha256(normalizeCreateBody(body));
      const idempotencyKey = request.headers["idempotency-key"];

      const authHeader = request.headers.authorization;
      const clientId = deps.apiAuthEnabled
        ? (() => {
            if (!authHeader?.startsWith("Bearer ")) {
              throw new ApiError(401, "UNAUTHORIZED", "Missing bearer token.", "auth", false);
            }
            const tokenHash = sha256(authHeader.slice("Bearer ".length));
            const client = deps.registry.raw.clients.find((c) => c.apiTokenHash === tokenHash);
            if (!client || !client.enabled) {
              throw new ApiError(401, "UNAUTHORIZED", "Invalid API token.", "auth", false);
            }
            return client.id;
          })()
        : "anonymous";

      if (typeof idempotencyKey === "string") {
        const existing = deps.executions.findByClientIdempotency(clientId, idempotencyKey);
        if (existing) {
          if (existing.requestBodyHash !== requestBodyHash) {
            throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different body.", "validation", false, existing.id);
          }
          reply.code(200);
          return toRelayExecutionResponse(existing, deps.relayerTransactions.getByExecutionId(existing.id));
        }
      }

      if (body.kind !== "clearMacroV1") {
        throw new ApiError(400, "UNSUPPORTED_RELAY_KIND", "Only clearMacroV1 is enabled in v1.", "validation", false);
      }

      const chainConfig = deps.registry.chainsById.get(body.chainId);
      if (!chainConfig) {
        throw new ApiError(403, "CHAIN_NOT_ALLOWED", "Unsupported chain.", "validation", false);
      }
      const forwarderAddress = chainConfig.forwarders[body.kind].toLowerCase();

      const metadata = body.metadata ?? {};
      if (Object.keys(metadata).length > deps.requestMaxMetadataKeys) {
        throw new ApiError(400, "VALIDATION_ERROR", "Too many metadata keys.", "validation", false);
      }
      for (const value of Object.values(metadata)) {
        if (value.length > deps.requestMaxMetadataValueLength) {
          throw new ApiError(400, "VALIDATION_ERROR", "Metadata value too long.", "validation", false);
        }
      }

      let decoded;
      try {
        decoded = decodeClearMacroPayload(body.payload);
      } catch {
        throw new ApiError(422, "INVALID_CLEAR_MACRO_PAYLOAD", "Payload is not valid ABI-encoded clear macro payload.", "user", false);
      }
      if (decoded.macroContract !== body.macroAddress.toLowerCase()) {
        throw new ApiError(422, "INVALID_CLEAR_MACRO_PAYLOAD", "Macro mismatch in payload.", "user", false);
      }
      if (decoded.provider === "self") {
        throw new ApiError(403, "PROVIDER_NOT_ALLOWED", "Provider self is not allowed.", "validation", false);
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      if (decoded.validBefore !== 0n && decoded.validBefore <= now) {
        throw new ApiError(422, "CLEAR_MACRO_EXPIRED", "Request has expired.", "user", false);
      }
      if (decoded.validAfter > now) {
        throw new ApiError(422, "CLEAR_MACRO_NOT_YET_VALID", "Request is not valid yet.", "user", true);
      }

      const policy = validateRegistryPolicy(deps.registry, {
        chainId: body.chainId,
        kind: body.kind,
        forwarder: forwarderAddress,
        macro: body.macroAddress,
        provider: decoded.provider,
        clientId,
        apiAuthEnabled: deps.apiAuthEnabled,
      });
      if (!policy.ok) {
        const status = policy.code === "CHAIN_NOT_ALLOWED" || policy.code === "MACRO_NOT_ALLOWED" || policy.code === "PROVIDER_NOT_ALLOWED" ? 403 : 400;
        throw new ApiError(status, policy.code, policy.message, "validation", false);
      }

      const readiness = await deps.getChainReadiness(body.chainId);
      if (!readiness.ready) {
        throw new ApiError(503, readiness.reasonCode ?? "PROVIDER_NOT_READY", "Requested chain is not ready.", "provider", true);
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
        throw new ApiError(503, "CHAIN_UNAVAILABLE", "Unable to read ClearMacro digest from app RPCs.", "chain", true);
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
        throw new ApiError(503, "CHAIN_UNAVAILABLE", "Unable to validate signature with app RPCs.", "chain", true);
      }
      if (!validSignature) {
        throw new ApiError(422, "SIGNATURE_INVALID", "EOA signature validation failed.", "user", false);
      }

      let inserted;
      try {
        inserted = deps.executions.createAccepted({
          clientId,
          clientRequestId: body.clientRequestId ?? null,
          idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
          requestBodyHash,
          kind: body.kind,
          chainId: body.chainId,
          ozRelayerId: policy.ozRelayerId,
          forwarderAddress,
          macroAddress: body.macroAddress.toLowerCase(),
          signerAddress: body.signerAddress.toLowerCase(),
          provider: decoded.provider,
          nonce: decoded.nonce.toString(),
          validAfter: decoded.validAfter.toString(),
          validBefore: decoded.validBefore.toString(),
          value: body.value ?? "0",
          payload: body.payload,
          signature: body.signature,
          permit2Json: null,
          metadataJson: JSON.stringify(metadata),
          requiredConfirmations: policy.confirmations,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("relay_executions_semantic_uniq") || message.includes("relay_executions.chain_id")) {
          throw new ApiError(409, "DUPLICATE_EXECUTION", "A matching execution already exists.", "validation", false);
        }
        if (message.includes("relay_executions_client_idempotency_uniq") || message.includes("relay_executions.client_id")) {
          const existing = typeof idempotencyKey === "string" ? deps.executions.findByClientIdempotency(clientId, idempotencyKey) : undefined;
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key conflict.", "validation", false, existing?.id ?? null);
        }
        throw error;
      }
      deps.executionEvents.append({
        executionId: inserted.id,
        type: "state_changed",
        actor: "api",
        reason: "Execution accepted after synchronous validation",
        detailsJson: JSON.stringify({ chainId: inserted.chainId, kind: inserted.kind }),
      });

      const relayer = deps.relayerTransactions.getByExecutionId(inserted.id);
      if (relayer) {
        const projection = projectRelayerState({
          status: relayer.status,
          statusReason: relayer.statusReason,
          hash: relayer.txHash,
          confirmedAt: relayer.confirmedAt,
          receipt: inserted.receiptJson ? JSON.parse(inserted.receiptJson) : null,
          requiredConfirmations: inserted.requiredConfirmations,
        });
        if (projection.state !== inserted.state) {
          inserted = deps.executions.transitionState(inserted.id, projection.state);
        }
      }
      reply.code(202);
      return toRelayExecutionResponse(inserted, relayer);
    },
  );

  app.get(
    "/v1/relay-executions/:id",
    {
      schema: { response: { 200: RelayExecutionEventsResponseSchema, 404: ErrorBodySchema } },
    },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const row = deps.executions.getById(id);
      if (!row) {
        throw new ApiError(404, "EXECUTION_NOT_FOUND", "Relay execution not found.", "validation", false);
      }
      const includeEvents = (request.query as { include?: string }).include === "events";
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

  app.get("/v1/capabilities", async () => {
    return {
      service: { name: "clearmacro-provider", version: "0.1.0" },
      relayApi: {
        endpoint: "/v1/relay-executions",
        supportedKinds: ["clearMacroV1"],
        states: ["accepted", "pending", "submitted", "included", "succeeded", "reverted", "rejected", "failed", "expired", "canceled"],
        supportsIdempotencyKey: true,
        supportsWaitEndpoint: false,
      },
      chains: deps.registry.raw.chains.map((chain) => ({
        chainId: chain.chainId,
        name: chain.name,
        enabled: chain.enabled,
        ready: true,
        forwarders: { clearMacroV1: chain.forwarders.clearMacroV1 },
        providers: chain.providers,
        macros: chain.macros.map((m) => ({ address: m.address, name: m.name, enabled: m.enabled, supportedKinds: m.supportedKinds })),
      })),
    };
  });
}
