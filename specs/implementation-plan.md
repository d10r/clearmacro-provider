# ClearMacro Provider Backend: Implementation Plan

> **Status:** Superseded for implementation details by the code + [`simplified-dapp-facing-relay-api.md`](./simplified-dapp-facing-relay-api.md). Kept as historical milestone notes.

## Goal

Implement the ClearMacro provider backend as a production-ready TypeScript service with a small API, SQLite-backed app state, static registry policy, Prometheus metrics, and OpenZeppelin Relayer as the transaction backend.

This document is intended for an implementer LLM. Prefer the simplest implementation that satisfies the specified behavior. Do not add architectural layers unless a milestone explicitly requires them.

## Scope Decisions

- Language/runtime: TypeScript on Node.js 24+.
- HTTP framework: Fastify.
- API schema: TypeBox as the single source for runtime validation and OpenAPI.
- EVM/RPC library: viem.
- App database: SQLite using Node's built-in `node:sqlite` APIs.
- Transaction backend: self-hosted OpenZeppelin Relayer.
- Relayer persistence: Redis repository storage for OpenZeppelin Relayer.
- Metrics: `prom-client`.
- v1 relay kinds: implement `clearMacroV1` first. Keep schemas ready for `permit2ClearMacroV1`, but keep it registry-disabled until implemented.

## Project Structure

Create this structure:

```text
src/
  main.ts
  app.ts
  api/
    routes.ts
    schemas.ts
    errors.ts
  chain/
    clients.ts
  config/
    env.ts
    registry.ts
    schema.ts
  db/
    client.ts
    migrations.ts
    repositories.ts
  metrics/
    metrics.ts
  relayer/
    client.ts
    mapper.ts
    worker.ts
  tx/
    lifecycle.ts
    builder.ts
  validation/
    clearmacro.ts
    registry.ts
test/
  unit/
  integration/
  fixtures/
scripts/
  migrate.ts
config/
  provider.example.json
  oz-relayer/
    config.json
    networks/
      evm.json
    keys/
      .gitkeep
```

Responsibilities:

- `main.ts`: load env/config, run migrations if enabled, start Fastify, start relayer worker.
- `app.ts`: create and configure Fastify instance without starting the network listener.
- `api/schemas.ts`: all TypeBox schemas exported for routes and OpenAPI.
- `api/errors.ts`: error code definitions and conversion to HTTP responses.
- `api/routes.ts`: route registration only; no validation, relayer, or database logic inline.
- `config/env.ts`: parse env vars, fail fast on invalid required values.
- `config/registry.ts`: load static registry JSON and expose lookup helpers.
- `db/client.ts`: open SQLite database, set pragmas, expose transaction helper.
- `db/migrations.ts`: migration definitions and migration runner.
- `db/repositories.ts`: database operations grouped by aggregate.
- `relayer/client.ts`: typed HTTP client for OpenZeppelin Relayer.
- `relayer/mapper.ts`: map OpenZeppelin Relayer transactions to ClearMacro lifecycle states.
- `relayer/worker.ts`: submit accepted requests without relayer transaction IDs, poll non-terminal relayer transactions, and update app state.
- `tx/builder.ts`: encode `ClearMacroForwarderV1.runMacro(...)` transaction payloads.
- `tx/lifecycle.ts`: request/audit event enums and transition helpers.
- `validation/clearmacro.ts`: decode and validate ClearMacro payloads.
- `validation/registry.ts`: enforce static registry policy.

## Environment Variables

Required:

- `DATABASE_PATH`: SQLite database path. In containers use `/data/clearmacro-provider.sqlite`.
- `OZ_RELAYER_URL`: base URL for OpenZeppelin Relayer API, for example `http://oz-relayer:8080`.
- `OZ_RELAYER_API_KEY`: API key used by the ClearMacro Provider app to call OpenZeppelin Relayer.

Optional:

- `PROVIDER_CONFIG_PATH`: path to provider config JSON file. Default: `config/provider.json`.
- `HOST`: bind address. Default: `0.0.0.0`.
- `PORT`: HTTP listen port for the Node process. Default: `3000`. In `compose.prod.yaml` the container pins this to `3000`; set `CLEARMACRO_PROVIDER_HOST_PORT` for the host port in Compose `ports:` (host → container `3000`; same variable as `compose.dashboard-op-sepolia.yaml`).
- `LOG_LEVEL`: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default: `info`.
- `RUN_MIGRATIONS_ON_START`: `true` or `false`. Default: `true`.
- `RELAYER_WORKER_ENABLED`: `true` or `false`. Default: `true`.
- `RELAYER_WORKER_POLL_INTERVAL_MS`: default `2000`.
- `API_AUTH_ENABLED`: `true` or `false`. Default: `false` for v1.
- `DEFAULT_CONFIRMATIONS`: positive integer. Default: `1`.
- `REQUEST_MAX_METADATA_KEYS`: integer. Default: `20`.
- `REQUEST_MAX_METADATA_VALUE_LENGTH`: integer. Default: `256`.
- `RELAYER_REQUEST_TIMEOUT_MS`: default `10000`.
- `RELAYER_WORKER_BATCH_SIZE`: default `25`.

Do not read environment variables directly outside `config/env.ts`.

## Static Registry Format

`config/provider.example.json` is the tracked **minimal** example for the current static config format (copy to `config/provider.json` for local/prod). The older multi-field registry sketch below is **not** the on-disk schema anymore; see `src/config/schema.ts` and `config/provider.example.json` for the real shape:

```json
{
  "version": 1,
  "chains": [
    {
      "chainId": 8453,
      "name": "base-mainnet",
      "enabled": false,
      "ozRelayerId": "base-mainnet-relayer",
      "rpcs": [
        {
          "name": "example",
          "url": "https://example.invalid"
        }
      ],
      "confirmations": 1,
      "superfluidHost": "0x0000000000000000000000000000000000000000",
      "forwarders": {
        "clearMacroV1": "0x0000000000000000000000000000000000000000",
        "permit2ClearMacroV1": "0x0000000000000000000000000000000000000000"
      },
      "providers": ["macros.superfluid.eth"],
      "macros": [
        {
          "address": "0x0000000000000000000000000000000000000000",
          "name": "ExampleMacro",
          "enabled": false,
          "supportedKinds": ["clearMacroV1"]
        }
      ]
    }
  ],
  "clients": [
    {
      "id": "default",
      "enabled": true,
      "apiTokenHash": null,
      "allowedChains": [8453],
      "allowedProviders": ["macros.superfluid.eth"],
      "allowedMacros": ["0x0000000000000000000000000000000000000000"]
    }
  ]
}
```

Rules:

- Address comparisons are case-insensitive. Store normalized lowercase addresses in SQLite.
- Each `chains[].rpcs[]` entry must have a stable `name` and `url`. Use these RPCs for local validation/preflight only.
- OpenZeppelin Relayer owns execution RPC failover. Its file-based network config must include equivalent or stronger RPC coverage for each enabled chain.
- Logs, metrics, and audit events should use RPC `name`, not the full URL.
- `chains[].enabled=false` means reject new requests for that chain.
- `macros[].enabled=false` means reject new requests for that macro.
- If `API_AUTH_ENABLED=false`, use client id `anonymous` and only global chain/macro/provider policy.
- If `API_AUTH_ENABLED=true`, require a bearer token and match it to `clients[].apiTokenHash`.

## SQLite Schema

Use UUIDv7-style strings for ids if available; otherwise UUIDv4 is acceptable for v1. Store timestamps as RFC 3339 text in UTC. Store uint256-like values as decimal text.

### `schema_migrations`

- `version text primary key`
- `applied_at text not null`

### `relay_requests`

- `id text primary key`
- `client_id text not null`
- `client_request_id text null`
- `idempotency_key text null`
- `request_body_hash text not null`
- `kind text not null`
- `state text not null`
- `terminal integer not null default 0`
- `chain_id integer not null`
- `oz_relayer_id text not null`
- `oz_transaction_id text null`
- `forwarder text not null`
- `macro text not null`
- `signer text not null`
- `provider text not null`
- `clear_macro_nonce text not null`
- `valid_after text not null`
- `valid_before text not null`
- `msg_value text not null default '0'`
- `params text not null`
- `signature text null`
- `permit2_json text null`
- `metadata_json text not null default '{}'`
- `current_tx_hash text null`
- `required_confirmations integer null`
- `last_error_json text null`
- `created_at text not null`
- `updated_at text not null`
- `terminal_at text null`

Indexes/constraints:

- unique `(client_id, idempotency_key)` where `idempotency_key is not null`.
- unique semantic duplicate index on `(chain_id, forwarder, macro, signer, clear_macro_nonce)`.
- index `(state, chain_id, created_at)` for the relayer worker.
- index `(chain_id, current_tx_hash)` where `current_tx_hash is not null`.
- index `(oz_relayer_id, oz_transaction_id)` where `oz_transaction_id is not null`.

### `relayer_transactions`

One row per OpenZeppelin Relayer transaction ID known to the app. Replacements update the same OpenZeppelin transaction ID and may change the hash, so preserve status snapshots over time in audit events.

- `oz_transaction_id text primary key`
- `request_id text not null references relay_requests(id)`
- `oz_relayer_id text not null`
- `status text not null`
- `status_reason text null`
- `tx_hash text null`
- `nonce text null`
- `gas_limit text null`
- `gas_price text null`
- `max_fee_per_gas text null`
- `max_priority_fee_per_gas text null`
- `raw_json text not null`
- `submitted_at text null`
- `confirmed_at text null`
- `last_polled_at text null`
- `created_at text not null`
- `updated_at text not null`

Indexes:

- index `(request_id)`.
- index `(status, updated_at)`.
- index `(tx_hash)` where `tx_hash is not null`.

### `audit_events`

Append-only audit/event log.

- `id text primary key`
- `request_id text not null references relay_requests(id)`
- `type text not null`
- `actor text not null`
- `reason text not null`
- `details_json text not null default '{}'`
- `created_at text not null`

Indexes:

- index `(request_id, created_at)`.
- index `(type, created_at)`.

## OpenZeppelin Relayer Adapter Contract

Use native `fetch` with this minimal HTTP contract. All requests to OpenZeppelin Relayer include:

- `Authorization: Bearer ${OZ_RELAYER_API_KEY}`
- `Content-Type: application/json`

### Health And Readiness

- `GET /api/v1/health` returns `200` and body `OK` when the relayer process is live.
- `GET /api/v1/ready` returns JSON with `ready`, `status`, and component details. Treat any non-2xx response or `ready !== true` as not ready.

### Relayer Details

- `GET /api/v1/relayers/{ozRelayerId}` returns an envelope with `data.address`, `data.paused`, `data.system_disabled`, and policy fields.
- Use `data.address` as the signer address for readiness balance checks.
- A relayer is usable only when it is not paused, not system-disabled, and its configured chain is enabled in the app registry.

### Submit Transaction

Endpoint:

```text
POST /api/v1/relayers/{ozRelayerId}/transactions
```

Request body for `clearMacroV1`:

```json
{
  "to": "0xforwarder",
  "value": "0",
  "data": "0xencodedRunMacro",
  "speed": "fast"
}
```

Use decimal strings for `value`. Let OpenZeppelin Relayer estimate gas unless a measured issue requires sending `gas_limit`.

Successful response shape:

```ts
type OzEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
};

type OzTransaction = {
  id: string;
  hash: string | null;
  status: string;
  status_reason: string | null;
  created_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
  gas_price: string | null;
  gas_limit: number | null;
  nonce: number | null;
  value: string;
  from: string;
  to: string;
  relayer_id: string;
  data: string;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
};
```

Persist `data.id` as `oz_transaction_id` immediately. Persist the whole `data` object as `relayer_transactions.raw_json` for internal audit/debugging only.

### Get Transaction

Endpoint:

```text
GET /api/v1/relayers/{ozRelayerId}/transactions/{ozTransactionId}
```

Response shape is the same `OzEnvelope<OzTransaction>`. Use this endpoint for all reconciliation.

### Manual Replacement And Cancel

These endpoints are operator-only and not part of the public v1 API:

- `PUT /api/v1/relayers/{ozRelayerId}/transactions/{ozTransactionId}` for replacement.
- `DELETE /api/v1/relayers/{ozRelayerId}/transactions/{ozTransactionId}` for cancel.

If implemented later, replacements must use explicit numeric fee fields after the transaction has reached `submitted`. Do not rely on speed-only replacement.

## ClearMacro ABI Contract

Use these ABI fragments. Do not invent alternate names or tuple shapes.

```ts
export const clearMacroForwarderV1Abi = [
  {
    type: "function",
    name: "runMacro",
    stateMutability: "payable",
    inputs: [
      { name: "macro", type: "address" },
      { name: "params", type: "bytes" },
      { name: "signer", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "getDigest",
    stateMutability: "view",
    inputs: [
      { name: "macro", type: "address" },
      { name: "params", type: "bytes" },
    ],
    outputs: [{ name: "digest", type: "bytes32" }],
  },
] as const;

export const clearMacroPayloadAbiParameters = [
  {
    name: "payload",
    type: "tuple",
    components: [
      {
        name: "action",
        type: "tuple",
        components: [{ name: "params", type: "bytes" }],
      },
      {
        name: "security",
        type: "tuple",
        components: [
          { name: "domain", type: "string" },
          { name: "macroContract", type: "address" },
          { name: "provider", type: "string" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      },
    ],
  },
] as const;
```

If these fragments disagree with `ethereum-contracts/contracts/utils/ClearMacroForwarderV1.sol` or `ethereum-contracts/contracts/interfaces/IClearMacroForwarderV1.sol`, follow the contract source and update this spec before implementation.

## API Implementation Rules

- `POST /v1/relay` does synchronous validation, persists the request as `accepted`, appends `request_accepted`, then returns `202`.
- Validation failures before persistence return HTTP errors and do not create database rows.
- If validation fails after persistence, transition to `rejected` and append `request_rejected`.
- The app builds `ClearMacroForwarderV1.runMacro(macro, params, signer, signature)` calldata and submits it to OpenZeppelin Relayer with `to = forwarder` and `value = msgValue`.
- The app persists OpenZeppelin Relayer transaction ID as soon as submission succeeds.
- The relayer worker polls SQLite for non-terminal work. Requests without `oz_transaction_id` are submitted to OpenZeppelin Relayer. Requests with `oz_transaction_id` are polled and projected into ClearMacro request state.
- `GET /v1/requests/{id}` returns the current request and relayer transaction summary. Audit events are returned only if `?include=events` is present.
- Do not expose OpenZeppelin Relayer API keys, signer config, private keys, raw secrets, or full RPC URLs in any API response.

## Validation Boundary

Keep the synchronous API path deterministic and bounded. `POST /v1/relay` must complete these checks before persistence:

- JSON schema and primitive format validation.
- Registry chain, forwarder, macro, provider, relay kind, and client policy checks.
- ClearMacro payload ABI decoding.
- `payload.security.macroContract` equals request `macro`.
- `payload.security.provider` is allowed and is not `self`.
- `validBefore` has not elapsed.
- `validAfter` is not in the future unless delayed execution is explicitly enabled.
- EOA signature validation for `clearMacroV1` using `getDigest(macro, params)` and local signature recovery.
- Idempotency replay/conflict and semantic duplicate checks.

Only these checks may happen after persistence in v1:

- Optional preflight simulation.
- OpenZeppelin Relayer submission.
- OpenZeppelin Relayer status reconciliation.

Post-persistence validation failures therefore mean asynchronous checks only. They must transition the request to `preflight_failed`, `submit_failed`, `rejected`, or `failed` according to the canonical state machine below. Do not defer cheap deterministic request validation until after persistence.

## Request State Machine

Canonical states:

| State | Terminal | Meaning |
| --- | --- | --- |
| `accepted` | no | Synchronous validation passed and request was persisted. |
| `queued` | no | Relayer worker claimed or is ready to submit the request. |
| `preflight_failed` | yes | Optional preflight simulation deterministically indicated revert/invalid execution before relayer submission. |
| `submit_failed` | yes | OpenZeppelin Relayer did not accept the transaction intent after retry policy. |
| `pending` | no | OpenZeppelin Relayer accepted the transaction intent and the request is awaiting terminal relayer status. |
| `confirmed` | yes | OpenZeppelin Relayer reports successful terminal status. |
| `reverted` | yes | OpenZeppelin Relayer reports failed status with an onchain revert signal. |
| `canceled` | yes | OpenZeppelin Relayer reports cancellation and no later terminal onchain outcome supersedes it. |
| `expired` | yes | Request expired before relayer submission or relayer reports expiry. |
| `rejected` | yes | Request was persisted but later rejected by an allowed asynchronous policy check. Use sparingly. |
| `failed` | yes | Terminal infrastructure or unknown failure after acceptance. |

Allowed transitions:

| From | To |
| --- | --- |
| none | `accepted` |
| `accepted` | `queued`, `preflight_failed`, `expired`, `rejected`, `failed` |
| `queued` | `pending`, `preflight_failed`, `submit_failed`, `expired`, `failed` |
| `pending` | `confirmed`, `reverted`, `canceled`, `expired`, `failed` |

Terminal states must not transition in v1. If later evidence contradicts a terminal state, append an audit event and alert; do not automatically rewrite history.

Retry rules:

- Relayer worker retry of transient submit errors happens while the request remains `queued`.
- Once submit retries are exhausted, transition to `submit_failed`.
- Polling failures while a request is `pending` do not change state unless the transaction ID becomes permanently unqueryable under policy; then transition to `failed` with `RELAYER_TRANSACTION_NOT_FOUND`.
- Duplicate `POST /v1/relay` calls resolved by idempotency do not create state transitions.

## Preflight Scope

Preflight simulation is part of Milestone 5, before OpenZeppelin Relayer submission. It uses the app registry RPCs and simulates the exact forwarder call:

- `to = forwarder`
- `value = msgValue`
- `data = runMacro(macro, params, signer, signature)`

Preflight outcomes:

- Deterministic revert or invalid execution: transition to `preflight_failed`.
- RPC/network failure with another app RPC available: retry another app RPC.
- All app RPCs unavailable before request acceptance: return `503 CHAIN_UNAVAILABLE`.
- All app RPCs unavailable after request persistence: leave request `queued`, append an audit event, and retry later.
- Successful preflight: proceed to OpenZeppelin Relayer submission.

Preflight is a guardrail, not a guarantee. A transaction that passes preflight may still later become `reverted`.

## Confirmation Semantics

OpenZeppelin Relayer is the source of truth for transaction terminal status. The ClearMacro Provider app does not independently poll receipts for confirmation depth in v1.

Confirmation precedence:

1. OpenZeppelin Relayer network config `required_confirmations` controls when OZ reports `confirmed`.
2. Registry `chains[].confirmations` documents the app expectation for that chain and must match the OZ network config for enabled chains at readiness time.
3. `DEFAULT_CONFIRMATIONS` is only a default used when loading registry entries that omit `confirmations`; explicit registry values win.
4. `relay_requests.required_confirmations` stores the effective registry value used for that request for audit/display.

If registry confirmations and OZ network confirmations differ for an enabled chain, `/readyz` must fail and new requests for that chain must be rejected with `PROVIDER_NOT_READY` until config is fixed. Implement this by reading the relayer's `network` and `network_type` from `GET /api/v1/relayers/{ozRelayerId}`, then reading `required_confirmations` from `GET /api/v1/networks/{network_type}:{network}`.

## Idempotency Namespace

When `API_AUTH_ENABLED=true`, idempotency keys are scoped by authenticated client id.

When `API_AUTH_ENABLED=false`, all requests use client id `anonymous`. This intentionally creates one shared unauthenticated idempotency namespace. Operators who need per-dapp idempotency isolation must enable API auth and configure clients.

Idempotency behavior:

- Same client id + same `Idempotency-Key` + same body hash returns the original request.
- Same client id + same `Idempotency-Key` + different body hash returns `409 IDEMPOTENCY_CONFLICT`.
- Missing `Idempotency-Key` does not disable semantic duplicate detection.

## Readiness Policy

`/readyz` is global and fails if any enabled chain is not ready. This is for operations and alerting.

Request acceptance is per-chain:

- If the requested chain is disabled, return `403 CHAIN_NOT_ALLOWED`.
- If the requested chain is enabled but its app RPCs, OZ Relayer, signer balance, or confirmation config are not ready, return `503 PROVIDER_NOT_READY` or `503 RELAYER_UNAVAILABLE` as appropriate.
- Readiness failures for one enabled chain should not prevent requests for another ready enabled chain unless the shared SQLite database or shared OZ Relayer service is unavailable.

## OpenZeppelin Relayer Rules

- OpenZeppelin Relayer runs as a separate service.
- Redis repository storage is required with `REPOSITORY_STORAGE_TYPE=redis` and `RESET_STORAGE_ON_START=false`.
- `STORAGE_ENCRYPTION_KEY` must remain stable across restarts.
- The ClearMacro Provider app talks to OpenZeppelin Relayer over its HTTP API using `OZ_RELAYER_API_KEY`.
- OpenZeppelin Relayer config is file-based and mounted into the container.
- The app must check relayer readiness before accepting work for enabled chains.
- The app must fetch each enabled relayer's signer address from `GET /api/v1/relayers/{ozRelayerId}` and check native-token balance with the registry app RPCs.
- A chain is ready only when signer balance is greater than zero. Add a configurable minimum later only if operations require it.
- v1 supports one running app instance with one relayer worker. Do not run multiple app containers or multiple worker processes against the same SQLite database unless atomic distributed claiming is implemented later.

## Replacement And Cancel Policy

Normal v1 operation should rely on OpenZeppelin Relayer's automatic transaction handling. Manual replacement/cancel support may be implemented for operator workflows.

Rules:

- Use explicit fee fields for replacements after the relayer transaction has status `submitted` and exposes nonce/hash/fee fields.
- Fee fields sent to OpenZeppelin Relayer replacement APIs must be JSON numbers when the relayer API expects numeric `u128` fields.
- Do not rely on speed-only replacement for recovery; it can fail when the relayer cannot calculate a sufficient bump.
- Cancel is allowed for operator intervention. If relayer cancel succeeds, project the request to `canceled` unless a receipt later proves a terminal onchain outcome.

## Implementation Milestones

### Milestone 1: Project Skeleton And Config

- Create source layout.
- Implement env parsing.
- Implement registry JSON loading and validation.
- Implement Fastify app with health, readiness, metrics, and OpenAPI.
- Add example registry and OpenZeppelin Relayer config templates.

Tests:

- Env parser validation.
- Registry validation and lookup behavior.
- Health/readiness route basics.

### Milestone 2: SQLite And Repositories

- Implement SQLite client with WAL mode, foreign keys, and busy timeout.
- Implement migration runner.
- Create tables and indexes from this spec.
- Add repository helpers for requests, relayer transactions, and audit events.

Tests:

- Migration applies cleanly to a temporary SQLite database.
- Idempotency uniqueness.
- Semantic duplicate uniqueness.
- Atomic state update plus audit event insert.

### Milestone 3: API Without Transaction Execution

- Implement TypeBox schemas.
- Implement common error handling.
- Implement `POST /v1/relay` validation and persistence without relayer submission.
- Implement `GET /v1/requests/{id}`.
- Implement `GET /v1/capabilities`.

Tests:

- Request schema failures.
- Registry rejection failures.
- Idempotency replay/conflict.
- Status response with and without audit events.

### Milestone 4: ClearMacro Validation

- Decode `IClearMacroForwarderV1.Payload` from `params`.
- Extract `security.provider`, `security.macroContract`, `security.validAfter`, `security.validBefore`, and `security.nonce`.
- Verify macro address, provider, validity window, and relay kind.
- Verify EOA signatures locally using `forwarder.getDigest(macro, params)` and viem signature recovery.
- For ERC-1271 signers, defer to preflight/simulation rather than duplicating all contract-wallet logic locally.

Tests:

- Valid payload accepted.
- Macro mismatch rejected.
- Provider `self` rejected.
- Expired validity rejected.
- Invalid EOA signature rejected.

### Milestone 5: OpenZeppelin Relayer Submission

- Implement OpenZeppelin Relayer HTTP client.
- Build `runMacro` transaction payloads.
- Submit accepted requests to the configured OpenZeppelin Relayer ID.
- Persist relayer transaction IDs and initial status.
- Handle relayer HTTP failures as retryable or `submit_failed` according to error type.

Tests:

- Mock relayer accepted path.
- Mock relayer rejected path to `submit_failed`.
- Local Anvil + OpenZeppelin Relayer success path.
- Local Anvil + OpenZeppelin Relayer revert path.
- Burst submissions return distinct relayer transaction IDs without local nonce handling.

### Milestone 6: Relayer Worker And Recovery

- Implement one relayer worker loop for non-terminal requests.
- Submit requests without relayer transaction IDs.
- Poll requests with relayer transaction IDs.
- Map OpenZeppelin Relayer statuses to ClearMacro request states.
- Resume reconciliation after app restart from SQLite state.
- Verify OpenZeppelin Relayer restart recovery via Redis-backed transaction IDs.

Tests:

- Relayer `submitted` maps to `pending`.
- Relayer `confirmed` maps to `confirmed`.
- Relayer `failed` with revert status reason maps to `reverted`.
- Relayer `failed` without revert reason maps to `failed`.
- Request without relayer transaction ID is submitted exactly once under normal success.
- Request submission retry does not create duplicate app requests.
- App restart resumes polling existing relayer transaction IDs.

### Milestone 7: Observability And Operational Polish

- Implement Prometheus metrics from the main spec.
- Add structured logs with request id, chain id, relayer id, relayer transaction id, tx hash, macro, signer, and provider.
- Add readiness checks for SQLite, registry, app RPCs, and OpenZeppelin Relayer.
- Add production smoke test command guarded by explicit env flag.

Tests:

- Metrics endpoint exposes expected metric names.
- Key paths increment counters/histograms.
- Production smoke test refuses to run without opt-in env.

## Test Phases

- Unit tests: pure logic and mocked OpenZeppelin Relayer/API/RPC. Must be fast and run by default.
- Integration tests: temporary SQLite database and mocked relayer HTTP server.
- Local chain tests: Anvil + OpenZeppelin Relayer + Redis end-to-end tests. Run in CI if stable enough; otherwise run in nightly/manual workflow.
- Fork tests: focused compatibility suite. Manual or scheduled, not required for every PR.
- Production-network smoke tests: manual only, guarded by explicit opt-in and small-value safe transactions.

## Handoff Checklist

Before implementation starts, ensure:

- `package.json`, `tsconfig.json`, Dockerfile, and Compose files exist.
- `specs/initial-provider-plan.md`, `specs/implementation-plan.md`, `specs/transaction-policy.md`, and `specs/operations.md` exist.
- v1 scope is `clearMacroV1` execution; Permit2 remains schema/config-disabled until explicitly scheduled.
- Implementer understands that OpenZeppelin Relayer owns nonce management, signing, submission, replacement primitives, and relayer persistence.
- Implementer understands that SQLite stores ClearMacro app/audit state, not the relayer's internal transaction queue.
