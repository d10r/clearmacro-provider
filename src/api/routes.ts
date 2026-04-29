import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { RelayAcceptedResponseSchema, RelayRequestSchema, RequestStatusResponseSchema } from "./schemas.js";
import { ApiError, toErrorBody } from "./errors.js";
import type { LoadedRegistry } from "../config/registry.js";
import { decodeClearMacroPayload } from "../validation/clearmacro.js";
import { validateRegistryPolicy } from "../validation/registry.js";
import type { RelayRequestRepository, AuditEventRepository, RelayerTransactionRepository } from "../db/repositories.js";

type RegisterRoutesDeps = {
  registry: LoadedRegistry;
  requests: RelayRequestRepository;
  audits: AuditEventRepository;
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

export async function registerRoutes(app: FastifyInstance, deps: RegisterRoutesDeps): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send(toErrorBody(error, request.id));
      return;
    }
    const maybeFastifyError = error as { validation?: unknown; code?: string; statusCode?: number };
    if (
      maybeFastifyError.validation !== undefined ||
      maybeFastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      reply.status(400).send(toErrorBody(new ApiError(400, "VALIDATION_ERROR", "Request validation failed."), request.id));
      return;
    }
    app.log.error({ err: error }, "Unhandled API error");
    reply.status(500).send(toErrorBody(new ApiError(500, "INTERNAL_ERROR", "Unexpected server error"), request.id));
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
    "/v1/relay",
    {
      schema: {
        body: RelayRequestSchema,
        response: { 202: RelayAcceptedResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        kind: "clearMacroV1" | "permit2ClearMacroV1";
        chainId: number;
        forwarder: string;
        macro: string;
        signer: string;
        params: string;
        signature: string;
        msgValue?: string;
        clientRequestId?: string;
        metadata?: Record<string, string>;
      };
      const requestBodyHash = sha256(JSON.stringify(body));
      const idempotencyKey = request.headers["idempotency-key"];

      const authHeader = request.headers.authorization;
      const clientId = deps.apiAuthEnabled
        ? (() => {
            if (!authHeader?.startsWith("Bearer ")) {
              throw new ApiError(401, "UNAUTHORIZED", "Missing bearer token.");
            }
            const tokenHash = sha256(authHeader.slice("Bearer ".length));
            const client = deps.registry.raw.clients.find((c) => c.apiTokenHash === tokenHash);
            if (!client || !client.enabled) {
              throw new ApiError(401, "UNAUTHORIZED", "Invalid API token.");
            }
            return client.id;
          })()
        : "anonymous";

      if (typeof idempotencyKey === "string") {
        const existing = deps.requests.findByClientIdempotency(clientId, idempotencyKey);
        if (existing) {
          if (existing.requestBodyHash !== requestBodyHash) {
            throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different body.");
          }
          reply.code(202);
          return {
            requestId: existing.id,
            status: existing.state,
            chainId: existing.chainId,
            kind: existing.kind,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
            statusUrl: `/v1/requests/${existing.id}`,
          };
        }
      }

      if (body.kind !== "clearMacroV1") {
        throw new ApiError(400, "UNSUPPORTED_RELAY_KIND", "Only clearMacroV1 is enabled in v1.");
      }

      const metadata = body.metadata ?? {};
      if (Object.keys(metadata).length > deps.requestMaxMetadataKeys) {
        throw new ApiError(400, "VALIDATION_ERROR", "Too many metadata keys.");
      }
      for (const value of Object.values(metadata)) {
        if (value.length > deps.requestMaxMetadataValueLength) {
          throw new ApiError(400, "VALIDATION_ERROR", "Metadata value too long.");
        }
      }

      let decoded;
      try {
        decoded = decodeClearMacroPayload(body.params);
      } catch {
        throw new ApiError(400, "INVALID_CLEAR_MACRO_PAYLOAD", "Payload params are not valid ABI-encoded clear macro payload.");
      }
      if (decoded.macroContract !== body.macro.toLowerCase()) {
        throw new ApiError(400, "INVALID_CLEAR_MACRO_PAYLOAD", "Macro mismatch in payload.");
      }
      if (decoded.provider === "self") {
        throw new ApiError(400, "PROVIDER_NOT_ALLOWED", "Provider self is not allowed.");
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      if (decoded.validBefore !== 0n && decoded.validBefore <= now) {
        throw new ApiError(422, "CLEAR_MACRO_EXPIRED", "Request has expired.");
      }
      if (decoded.validAfter > now) {
        throw new ApiError(422, "CLEAR_MACRO_NOT_YET_VALID", "Request is not valid yet.");
      }

      const policy = validateRegistryPolicy(deps.registry, {
        chainId: body.chainId,
        kind: body.kind,
        forwarder: body.forwarder,
        macro: body.macro,
        provider: decoded.provider,
        clientId,
        apiAuthEnabled: deps.apiAuthEnabled,
      });
      if (!policy.ok) {
        const status = policy.code === "CHAIN_NOT_ALLOWED" || policy.code === "MACRO_NOT_ALLOWED" || policy.code === "PROVIDER_NOT_ALLOWED" ? 403 : 400;
        throw new ApiError(status, policy.code, policy.message);
      }

      const readiness = await deps.getChainReadiness(body.chainId);
      if (!readiness.ready) {
        throw new ApiError(503, readiness.reasonCode ?? "PROVIDER_NOT_READY", "Requested chain is not ready.");
      }

      let digest: string;
      try {
        digest = await deps.getForwarderDigest({
          chainId: body.chainId,
          forwarder: body.forwarder.toLowerCase(),
          macro: body.macro.toLowerCase(),
          params: body.params,
        });
      } catch {
        throw new ApiError(503, "CHAIN_UNAVAILABLE", "Unable to read ClearMacro digest from app RPCs.");
      }
      let validSignature: boolean;
      try {
        validSignature = await deps.validateRelaySignature({
          chainId: body.chainId,
          signer: body.signer.toLowerCase(),
          digest,
          signature: body.signature,
        });
      } catch {
        throw new ApiError(503, "CHAIN_UNAVAILABLE", "Unable to validate signature with app RPCs.");
      }
      if (!validSignature) {
        throw new ApiError(422, "SIGNATURE_INVALID", "EOA signature validation failed.");
      }

      let inserted;
      try {
        inserted = deps.requests.createAccepted({
          clientId,
          clientRequestId: body.clientRequestId ?? null,
          idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
          requestBodyHash,
          kind: body.kind,
          chainId: body.chainId,
          ozRelayerId: policy.ozRelayerId,
          forwarder: body.forwarder.toLowerCase(),
          macro: body.macro.toLowerCase(),
          signer: body.signer.toLowerCase(),
          provider: decoded.provider,
          clearMacroNonce: decoded.nonce.toString(),
          validAfter: decoded.validAfter.toString(),
          validBefore: decoded.validBefore.toString(),
          msgValue: body.msgValue ?? "0",
          params: body.params,
          signature: body.signature,
          permit2Json: null,
          metadataJson: JSON.stringify(metadata),
          requiredConfirmations: policy.confirmations,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("relay_requests_semantic_uniq") || message.includes("relay_requests.chain_id")) {
          throw new ApiError(409, "DUPLICATE_REQUEST", "A request with the same chain/forwarder/macro/signer/nonce already exists.");
        }
        if (message.includes("relay_requests_client_idempotency_uniq") || message.includes("relay_requests.client_id")) {
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key conflict.");
        }
        throw error;
      }
      deps.audits.append({
        requestId: inserted.id,
        type: "request_accepted",
        actor: "api",
        reason: "Request accepted after synchronous validation",
        detailsJson: JSON.stringify({ chainId: inserted.chainId, kind: inserted.kind }),
      });

      reply.code(202);
      return {
        requestId: inserted.id,
        status: inserted.state,
        chainId: inserted.chainId,
        kind: inserted.kind,
        createdAt: inserted.createdAt,
        updatedAt: inserted.updatedAt,
        statusUrl: `/v1/requests/${inserted.id}`,
      };
    },
  );

  app.get(
    "/v1/requests/:id",
    {
      schema: { response: { 200: RequestStatusResponseSchema } },
    },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const row = deps.requests.getById(id);
      if (!row) {
        throw new ApiError(404, "REQUEST_NOT_FOUND", "Request not found.");
      }
      const includeEvents = (request.query as { include?: string }).include === "events";
      const relayer = deps.relayerTransactions.getByRequestId(id);
      return {
        request: {
          id: row.id,
          state: row.state,
          terminal: row.terminal === 1,
          kind: row.kind,
          chainId: row.chainId,
          forwarder: row.forwarder,
          macro: row.macro,
          signer: row.signer,
          provider: row.provider,
          clearMacroNonce: row.clearMacroNonce,
          validAfter: row.validAfter,
          validBefore: row.validBefore,
          msgValue: row.msgValue,
          relayerId: row.ozRelayerId,
          relayerTransactionId: row.ozTransactionId ?? undefined,
          currentTxHash: row.currentTxHash ?? undefined,
          lastError: row.lastErrorJson ? JSON.parse(row.lastErrorJson) : undefined,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          terminalAt: row.terminalAt ?? undefined,
        },
        relayerTransaction: relayer
          ? {
              relayerId: relayer.ozRelayerId,
              relayerTransactionId: relayer.ozTransactionId,
              status: relayer.status,
              statusReason: relayer.statusReason ?? undefined,
              txHash: relayer.txHash ?? undefined,
              nonce: relayer.nonce ?? undefined,
              gasLimit: relayer.gasLimit ?? undefined,
              gasPrice: relayer.gasPrice ?? undefined,
              maxFeePerGas: relayer.maxFeePerGas ?? undefined,
              maxPriorityFeePerGas: relayer.maxPriorityFeePerGas ?? undefined,
              submittedAt: relayer.submittedAt ?? undefined,
              confirmedAt: relayer.confirmedAt ?? undefined,
              lastPolledAt: relayer.lastPolledAt ?? undefined,
            }
          : undefined,
        events: includeEvents ? deps.audits.listByRequest(id) : undefined,
      };
    },
  );

  app.get("/v1/capabilities", async () => {
    return {
      service: { name: "clearmacro-provider", version: "0.1.0" },
      chains: deps.registry.raw.chains.map((chain) => ({
        chainId: chain.chainId,
        name: chain.name,
        enabled: chain.enabled,
        ozRelayerId: chain.ozRelayerId,
        superfluidHost: chain.superfluidHost,
        forwarders: chain.forwarders,
        providers: chain.providers,
        macros: chain.macros.map((m) => ({ address: m.address, name: m.name, enabled: m.enabled, supportedKinds: m.supportedKinds })),
      })),
    };
  });
}
