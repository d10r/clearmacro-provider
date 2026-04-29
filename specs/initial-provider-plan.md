# ClearMacro Provider Backend: High-Level Plan

## Context

This project implements a production-ready backend provider for dapps using the ClearMacro pattern. In this context, a provider is an authorized offchain relayer/executor, identified by a signed provider string such as `macros.superfluid.eth`, not an RPC provider.

Users sign EIP-712 ClearMacro payloads. The provider validates and relays those payloads to `ClearMacroForwarderV1`, which verifies signatures, enforces provider authorization, checks nonce and validity windows, and executes Superfluid batch operations as the signer. `ClearMacroForwarderV1WithPermit2` is included in the API model, but Permit2 execution is disabled until a later milestone explicitly enables it.

The backend is intentionally split into two responsibilities:

- ClearMacro Provider app: API, validation, registry policy, idempotency, request lifecycle projection, audit records, and app metrics.
- OpenZeppelin Relayer: signing, nonce management, transaction submission, replacement/cancel primitives, transaction status tracking, RPC failover, relayer health, and relayer metrics.

OpenZeppelin Relayer must run with Redis repository storage. In-memory repository storage is not acceptable because accepted transaction IDs and status tracking must survive relayer restarts.

## First Iteration Scope

The first production iteration includes:

- API needed by dapps to submit and inspect ClearMacro relay requests.
- OpenZeppelin Relayer integration for transaction execution.
- SQLite-backed ClearMacro request, idempotency, and audit state.
- Prometheus-compatible observability for the app, plus OpenZeppelin Relayer's own metrics endpoint.
- A static registry for deciding which chains, forwarders, macro contracts, provider strings, and relayer IDs are enabled.
- One service instance supporting all configured chains with Superfluid deployments.
- A persisted request lifecycle from API acceptance through final transaction outcome.
- Auditability of validation decisions, relayer transaction IDs, hashes, relayer statuses, errors, and terminal outcomes.
- Tests covering API behavior, validation, lifecycle projection, OpenZeppelin Relayer adapter behavior, reverts, relayer downtime/recovery, and idempotency.

The relayer account is exclusively owned by OpenZeppelin Relayer for this service. No other process may submit transactions from the same account.

Throughput must not be limited by confirmation speed. OpenZeppelin Relayer is responsible for safely keeping multiple transactions in flight for a relayer account.

## Architecture

Core components:

- API server: accepts relay requests, returns request status, serves OpenAPI docs, exposes app health/readiness and metrics.
- Registry: static JSON config mapping chains, forwarders, macro contracts, provider strings, app RPC endpoints, and OpenZeppelin Relayer IDs.
- SQLite app store: canonical source of truth for ClearMacro request state, validation results, idempotency, relayer transaction IDs, relayer status snapshots, and audit events.
- OpenZeppelin Relayer adapter: submits transactions to OpenZeppelin Relayer and polls relayer transaction status.
- Relayer worker: submits accepted requests without relayer transaction IDs, polls submitted relayer transactions, and projects relayer statuses into ClearMacro request states.
- Observability layer: structured logs, app metrics, health checks, readiness checks, and links to relayer health/metrics.

## API Shape

Keep the public API small and idiomatic. The API must use one canonical schema source for runtime validation and OpenAPI generation.

- `POST /v1/relay`: submit a signed ClearMacro relay request.
- `GET /v1/requests/{id}`: inspect request lifecycle state and audit-relevant details.
- `GET /v1/capabilities`: expose supported chains, forwarders, macro contracts, relayer readiness, and provider identifiers.
- `GET /healthz`: liveness check.
- `GET /readyz`: readiness check.
- `GET /metrics`: Prometheus metrics for the ClearMacro Provider app.

OpenZeppelin Relayer exposes its own health/readiness and `/metrics`; the app readiness should verify that required relayers are reachable before accepting relay work.

### Shared API Conventions

Primitive formats:

- `Address`: lowercase or checksum EVM address string matching `^0x[0-9a-fA-F]{40}$`.
- `Bytes`: hex string matching `^0x([0-9a-fA-F]{2})*$`.
- `Bytes32`: hex string matching `^0x[0-9a-fA-F]{64}$`.
- `UintString`: non-negative base-10 integer encoded as a string. Use this for all uint256-like public API values.
- `ChainId`: positive integer. Must match an enabled registry chain.
- `RequestId`: server-generated opaque id. UUIDv7 is preferred.
- `DateTime`: RFC 3339 timestamp string.

Request headers:

- `Content-Type: application/json` is required for JSON requests.
- `Idempotency-Key` is optional on `POST /v1/relay`. If present, the same key and same authenticated client must return the original request. If the key is reused with a different body, return `409 IDEMPOTENCY_CONFLICT`.
- `Authorization` is optional for the first iteration if the registry is open. If enabled, use `Authorization: Bearer <token>` and map the token to a client id.

Successful responses return their direct schema, not a generic envelope. Errors always use the common error response.

### Common Error Response

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body is invalid.",
    "requestId": "018f2f2c-7c66-7b57-a9e1-ef0d95b51d10",
    "details": {
      "field": "chainId",
      "reason": "Unsupported chain id."
    }
  }
}
```

Error codes:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | JSON shape, hex format, enum, or required field validation failed. |
| 400 | `UNSUPPORTED_RELAY_KIND` | `kind` is unknown or not enabled. |
| 400 | `INVALID_CLEAR_MACRO_PAYLOAD` | `params` cannot be decoded as the expected ClearMacro payload or fails local consistency checks. |
| 400 | `INVALID_PERMIT2_PAYLOAD` | Permit2 payload is malformed or inconsistent with the ClearMacro payload. |
| 401 | `UNAUTHORIZED` | Missing or invalid API credential. |
| 403 | `CLIENT_NOT_ALLOWED` | Authenticated client is not allowed to use the requested chain/macro/provider. |
| 403 | `CHAIN_NOT_ALLOWED` | Chain is known but disabled by registry policy. |
| 403 | `MACRO_NOT_ALLOWED` | Macro contract is not allowed by registry policy. |
| 403 | `PROVIDER_NOT_ALLOWED` | Provider string is not allowed by registry policy. |
| 404 | `REQUEST_NOT_FOUND` | Relay request id does not exist or is not visible to the caller. |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotency-Key` was reused with a different body. |
| 409 | `DUPLICATE_REQUEST` | The same semantic relay request has already been accepted. |
| 422 | `SIGNATURE_INVALID` | Local signature validation failed. |
| 422 | `CLEAR_MACRO_EXPIRED` | `validBefore` is non-zero and already elapsed. |
| 422 | `CLEAR_MACRO_NOT_YET_VALID` | `validAfter` is in the future and delayed execution is disabled by policy. |
| 422 | `NONCE_ALREADY_USED` | The ClearMacro nonce is already consumed onchain or known terminal in provider state. |
| 422 | `SIMULATION_REVERTED` | Preflight simulation indicates the transaction would revert. |
| 429 | `RATE_LIMITED` | Client or global rate limit exceeded. |
| 503 | `CHAIN_UNAVAILABLE` | No healthy app RPC is available for validation/preflight on the requested chain. |
| 503 | `RELAYER_UNAVAILABLE` | Required OpenZeppelin Relayer is not reachable or not ready. |
| 503 | `PROVIDER_NOT_READY` | Service is live but cannot accept relay work. |
| 500 | `INTERNAL_ERROR` | Unexpected server error. |

Accepted requests that later fail transaction processing do not use HTTP errors. They transition to a terminal lifecycle state visible via `GET /v1/requests/{id}`.

### `POST /v1/relay`

Submits a ClearMacro request for relaying. Returns `202 Accepted` once the request passes synchronous validation and is persisted. It does not wait for OpenZeppelin Relayer submission, transaction inclusion, or confirmation.

v1 implementation scope is `kind: "clearMacroV1"`. The `permit2ClearMacroV1` schema is documented so the API shape can evolve without redesign, but requests of that kind return `400 UNSUPPORTED_RELAY_KIND` until the Permit2 milestone is enabled by registry policy.

```ts
type RelayRequest = ClearMacroRelayRequest | Permit2ClearMacroRelayRequest;

type ClearMacroRelayRequest = {
  kind: "clearMacroV1";
  chainId: ChainId;
  forwarder: Address;
  macro: Address;
  signer: Address;
  params: Bytes;
  signature: Bytes;
  msgValue?: UintString;
  clientRequestId?: string;
  metadata?: Record<string, string>;
};

type Permit2ClearMacroRelayRequest = {
  kind: "permit2ClearMacroV1";
  chainId: ChainId;
  forwarder: Address;
  macro: Address;
  params: Bytes;
  permit2: Permit2MacroParams;
  msgValue?: UintString;
  clientRequestId?: string;
  metadata?: Record<string, string>;
};
```

Validation rules:

- `forwarder` must be the configured ClearMacro forwarder for `chainId` and `kind`.
- `macro` must match `payload.security.macroContract` decoded from `params`.
- `payload.security.provider` must be allowed by registry policy.
- `payload.security.provider` must not be `self`; this backend relays only provider-authorized requests.
- `payload.security.validBefore` must be zero or greater than current time.
- If delayed execution is disabled, `payload.security.validAfter` must be less than or equal to current time.
- For `clearMacroV1`, EOA signatures must be validated locally against `forwarder.getDigest(macro, params)`. For ERC-1271 signers, rely on preflight/onchain validation rather than duplicating all contract-wallet logic locally in v1.
- For `permit2ClearMacroV1`, once implemented, the signer is `permit2.owner`. The Permit2 signature must be locally validated where practical, and `permit2.witness` must equal `forwarder.getPermit2WitnessStructHash(macro, params, permit2.upgradeSuperToken)`.
- `params` is the ABI-encoded `IClearMacroForwarderV1.Payload`.
- `msgValue` defaults to `"0"`.
- `metadata` is for client correlation only. It must not affect validation, transaction construction, or idempotency unless explicitly configured later.

Success response:

```ts
type RelayAcceptedResponse = {
  requestId: RequestId;
  status: RequestState;
  chainId: ChainId;
  kind: "clearMacroV1" | "permit2ClearMacroV1";
  createdAt: DateTime;
  updatedAt: DateTime;
  statusUrl: string;
};
```

### `GET /v1/requests/{id}`

Returns the current state and audit summary for a relay request. Internal audit events are excluded by default. Add `?include=events` to include them for support workflows.

```ts
type RelayRequestStatusResponse = {
  request: RelayRequestRecord;
  relayerTransaction?: RelayerTransactionRecord;
  events?: AuditEventRecord[];
};

type RelayRequestRecord = {
  id: RequestId;
  clientRequestId?: string;
  idempotencyKey?: string;
  kind: "clearMacroV1" | "permit2ClearMacroV1";
  state: RequestState;
  terminal: boolean;
  chainId: ChainId;
  forwarder: Address;
  macro: Address;
  signer: Address;
  provider: string;
  clearMacroNonce: UintString;
  validAfter: UintString;
  validBefore: UintString;
  msgValue: UintString;
  createdAt: DateTime;
  updatedAt: DateTime;
  terminalAt?: DateTime;
  lastError?: RequestErrorSummary;
  currentTxHash?: Bytes32;
  relayerId?: string;
  relayerTransactionId?: string;
  requiredConfirmations?: number;
};

type RelayerTransactionRecord = {
  relayerId: string;
  relayerTransactionId: string;
  status: string;
  statusReason?: string;
  txHash?: Bytes32;
  nonce?: UintString;
  gasLimit?: UintString;
  gasPrice?: UintString;
  maxFeePerGas?: UintString;
  maxPriorityFeePerGas?: UintString;
  submittedAt?: DateTime;
  confirmedAt?: DateTime;
  lastPolledAt?: DateTime;
};

type RequestState =
  | "accepted"
  | "queued"
  | "preflight_failed"
  | "submit_failed"
  | "pending"
  | "confirmed"
  | "reverted"
  | "canceled"
  | "expired"
  | "rejected"
  | "failed";

type AuditEventType =
  | "request_accepted"
  | "request_rejected"
  | "preflight_started"
  | "preflight_failed"
  | "preflight_succeeded"
  | "queued"
  | "relayer_submit_started"
  | "relayer_submit_failed"
  | "relayer_submit_accepted"
  | "relayer_status_polled"
  | "relayer_replacement_requested"
  | "relayer_replacement_accepted"
  | "relayer_cancel_requested"
  | "relayer_cancel_accepted"
  | "finalized"
  | "expired"
  | "failed";
```

### `GET /v1/capabilities`

Returns the currently configured relay capabilities. This is registry-derived and should be safe to cache briefly.

```ts
type CapabilitiesResponse = {
  service: {
    name: string;
    version: string;
  };
  chains: ChainCapability[];
};

type ChainCapability = {
  chainId: ChainId;
  name: string;
  enabled: boolean;
  ozRelayerId: string;
  superfluidHost: Address;
  forwarders: {
    clearMacroV1?: Address;
    permit2ClearMacroV1?: Address;
  };
  providers: string[];
  macros: MacroCapability[];
};
```

### Health, Readiness, And Metrics

- `/healthz` returns `200 OK` if the app process is alive.
- `/readyz` verifies app config, SQLite connectivity, registry validity, app RPC availability for enabled chains, required OpenZeppelin Relayer readiness, and native-token balance for each enabled relayer signer.
- `/metrics` exposes ClearMacro Provider metrics only. Configure Prometheus to scrape OpenZeppelin Relayer metrics separately.

## Lifecycle Mapping

OpenZeppelin Relayer statuses are projected into ClearMacro request states:

| OpenZeppelin Relayer status | ClearMacro state |
| --- | --- |
| `pending`, `sent`, `submitted` | `pending` |
| `confirmed`, `mined` | `confirmed` |
| `failed` with revert-like status reason | `reverted` |
| `failed` without revert signal | `failed` |
| `canceled` | `canceled` |
| `expired` | `expired` |

HTTP submission failures before OpenZeppelin Relayer accepts a transaction become `submit_failed` unless they are transient and retried successfully by the app.

## Observability

App metrics should include:

- request counts by kind, chain, client, and terminal state;
- validation failure counts by code;
- OpenZeppelin Relayer submission counts by relayer id and outcome;
- relayer status polling counts and latency;
- lifecycle duration histograms from accepted to terminal;
- readiness gauges for chains, app RPCs, SQLite, and relayers.

Logs and audit events must use registry RPC names and relayer IDs, not full RPC URLs or secrets.

## Security Notes

- The ClearMacro Provider app never loads or stores the relayer private key.
- Signing keys are managed by OpenZeppelin Relayer signer configuration.
- Do not expose OpenZeppelin Relayer directly to public clients. The app is the public API boundary.
- Do not store plaintext API tokens. Token hashing may use SHA-256 in v1.
- Do not include private keys, relayer API keys, RPC URLs with API keys, or webhook signing keys in logs, metrics, audit events, or API responses.
