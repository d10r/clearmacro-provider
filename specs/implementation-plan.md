# ClearMacro Provider Backend: Implementation Plan

## Goal

Implement the ClearMacro provider backend as a production-ready TypeScript service with a small API, durable transaction lifecycle, static registry policy, Prometheus metrics, and PostgreSQL-backed audit/recovery state.

This document is intended for an implementer LLM. Prefer the simplest implementation that satisfies the specified behavior. Do not add new architectural layers unless a milestone explicitly requires them.

## Scope Decisions

- Language/runtime: TypeScript on the latest Node.js LTS line, currently Node.js 24+.
- HTTP framework: Fastify.
- API schema: TypeBox as the single source for runtime validation and OpenAPI.
- EVM/RPC library: viem.
- Database: PostgreSQL.
- SQL access: Kysely + `pg`.
- Migrations: custom TypeScript migration runner using Kysely. Do not add a separate migration framework unless this becomes painful.
- Metrics: `prom-client`.
- Local/prod database: Docker Compose Postgres from this repo.
- v1 relay kinds: implement `clearMacroV1` first. Keep schemas ready for `permit2ClearMacroV1`, but it can be disabled by registry until implemented.

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
    metadata.ts
  config/
    env.ts
    registry.ts
    schema.ts
  db/
    client.ts
    schema.ts
    migrations.ts
    migrate.ts
    repositories.ts
  metrics/
    metrics.ts
  tx/
    lifecycle.ts
    policy.ts
    signer.ts
    worker.ts
    manager.ts
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
  registry.example.json
```

Responsibilities:

- `main.ts`: load env/config, run migrations if enabled, start Fastify, start workers.
- `app.ts`: create and configure Fastify instance without starting network listener.
- `api/schemas.ts`: all TypeBox schemas exported for routes and OpenAPI.
- `api/errors.ts`: error code definitions and conversion to HTTP responses.
- `api/routes.ts`: route registration only; no transaction logic inline.
- `config/env.ts`: parse env vars, fail fast on invalid required values.
- `config/registry.ts`: load static registry JSON and expose lookup helpers.
- `db/schema.ts`: Kysely table typings.
- `db/migrations.ts`: migration definitions.
- `db/repositories.ts`: database operations grouped by aggregate.
- `tx/lifecycle.ts`: request/attempt/audit event enums and transition helpers.
- `tx/policy.ts`: retry, gas, finality, dropped detection policy.
- `tx/signer.ts`: relayer account loading and transaction signing.
- `tx/manager.ts`: durable transaction processing logic.
- `tx/worker.ts`: per-chain polling loop that picks queued work.
- `validation/clearmacro.ts`: decode and validate ClearMacro payloads.
- `validation/registry.ts`: enforce static registry policy.

## Environment Variables

Required:

- `DATABASE_URL`: PostgreSQL connection string.
- `RELAYER_PRIVATE_KEY`: hex private key for the provider relayer account. This account must be exclusively controlled by this application.

Optional:

- `REGISTRY_PATH`: path to registry JSON file. Default: `config/registry.json`.
- `HOST`: bind address. Default: `0.0.0.0`.
- `PORT`: HTTP port. Default: `3000`.
- `LOG_LEVEL`: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default: `info`.
- `RUN_MIGRATIONS_ON_START`: `true` or `false`. Default: `true`.
- `WORKERS_ENABLED`: `true` or `false`. Default: `true`.
- `API_AUTH_ENABLED`: `true` or `false`. Default: `false` for v1.
- `DEFAULT_CONFIRMATIONS`: positive integer. Default: `1`.
- `REQUEST_MAX_METADATA_KEYS`: integer. Default: `20`.
- `REQUEST_MAX_METADATA_VALUE_LENGTH`: integer. Default: `256`.

Do not read environment variables directly outside `config/env.ts`.

## Static Registry Format

Create `config/registry.example.json` with this shape:

```json
{
  "version": 1,
  "chains": [
    {
      "chainId": 8453,
      "name": "base-mainnet",
      "enabled": false,
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

- Address comparisons are case-insensitive. Store normalized lowercase addresses in the database.
- Each `chains[].rpcs[]` entry must have a stable `name` and a `url`. Logs, metrics, and audit events should use the RPC `name`, not the full URL, to avoid leaking API keys.
- RPC order is preference order. Use the first healthy RPC by default and fail over to later entries.
- `chains[].enabled=false` means reject new requests for that chain.
- `macros[].enabled=false` means reject new requests for that macro.
- If `API_AUTH_ENABLED=false`, use client id `anonymous` and only global chain/macro/provider policy.
- If `API_AUTH_ENABLED=true`, require a bearer token and match it to `clients[].apiTokenHash`.
- Token hashing may be implemented with SHA-256 in v1. Do not store plaintext API tokens in config.

## Database Schema

Use UUIDv7-style strings for ids if available; otherwise UUIDv4 is acceptable for v1. All timestamps are `timestamptz`.

### `schema_migrations`

Tracks applied migrations.

- `version text primary key`
- `applied_at timestamptz not null default now()`

### `relay_requests`

Canonical request row.

- `id text primary key`
- `client_id text not null`
- `client_request_id text null`
- `idempotency_key text null`
- `request_body_hash text not null`
- `kind text not null`
- `state text not null`
- `terminal boolean not null default false`
- `chain_id bigint not null`
- `forwarder text not null`
- `macro text not null`
- `signer text not null`
- `provider text not null`
- `clear_macro_nonce numeric(78,0) not null`
- `valid_after numeric(78,0) not null`
- `valid_before numeric(78,0) not null`
- `msg_value numeric(78,0) not null default 0`
- `params text not null`
- `signature text null`
- `permit2 jsonb null`
- `metadata jsonb not null default '{}'::jsonb`
- `current_attempt_id text null`
- `current_tx_hash text null`
- `required_confirmations integer null`
- `confirmation_depth integer null`
- `last_error jsonb null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `terminal_at timestamptz null`

Indexes/constraints:

- unique `(client_id, idempotency_key)` where `idempotency_key is not null`.
- unique semantic duplicate index on `(chain_id, forwarder, macro, signer, clear_macro_nonce)`.
- index `(state, chain_id, created_at)` for workers.
- index `(chain_id, current_tx_hash)` where `current_tx_hash is not null`.

### `transaction_attempts`

One row per signed transaction attempt. Replacements create new rows.

- `id text primary key`
- `request_id text not null references relay_requests(id)`
- `attempt_number integer not null`
- `chain_id bigint not null`
- `state text not null`
- `nonce numeric(78,0) not null`
- `replacement_of_attempt_id text null references transaction_attempts(id)`
- `to_address text not null`
- `value numeric(78,0) not null default 0`
- `data text not null`
- `raw_tx text null`
- `tx_hash text null`
- `gas_limit numeric(78,0) null`
- `max_fee_per_gas numeric(78,0) null`
- `max_priority_fee_per_gas numeric(78,0) null`
- `gas_price numeric(78,0) null`
- `send_error jsonb null`
- `submitted_at timestamptz null`
- `first_seen_pending_at timestamptz null`
- `receipt jsonb null`
- `receipt_status text null`
- `confirmed_at timestamptz null`
- `block_number numeric(78,0) null`
- `block_hash text null`
- `transaction_index integer null`
- `effective_gas_price numeric(78,0) null`
- `gas_used numeric(78,0) null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes/constraints:

- unique `(request_id, attempt_number)`.
- unique `(chain_id, tx_hash)` where `tx_hash is not null`.
- index `(chain_id, nonce)`.
- index `(state, chain_id, updated_at)`.

### `audit_events`

Append-only audit/event log.

- `id text primary key`
- `request_id text not null references relay_requests(id)`
- `attempt_id text null references transaction_attempts(id)`
- `type text not null`
- `actor text not null`
- `reason text not null`
- `details jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`

Indexes:

- index `(request_id, created_at)`.
- index `(attempt_id, created_at)` where `attempt_id is not null`.
- index `(type, created_at)`.

### `nonce_reservations`

Durable local nonce reservations for relayer account per chain.

- `id text primary key`
- `chain_id bigint not null`
- `relayer_address text not null`
- `nonce numeric(78,0) not null`
- `request_id text not null references relay_requests(id)`
- `attempt_id text null references transaction_attempts(id)`
- `state text not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes/constraints:

- unique `(chain_id, relayer_address, nonce)`.
- unique `(request_id)` for the active v1 model where each request owns one relayer nonce. If replacement uses same nonce, it should reuse this reservation.
- index `(chain_id, relayer_address, state)`.

Reservation states:

- `reserved`
- `submitted`
- `finalized`
- `abandoned`

### `chain_cursors`

Stores per-chain relayer nonce cursor and recovery metadata.

- `chain_id bigint primary key`
- `relayer_address text not null`
- `next_nonce numeric(78,0) not null`
- `synced_onchain_nonce numeric(78,0) not null`
- `updated_at timestamptz not null default now()`

Rules:

- Initialize from `eth_getTransactionCount(relayer, "pending")` on first startup for a chain.
- After initialization, allocate nonces transactionally from `next_nonce`.
- Do not decrement `next_nonce` automatically. Recovery may alert on gaps but must not reuse a nonce unless no signed tx was ever persisted for it.

## API Implementation Rules

- `POST /v1/relay` should do synchronous validation, persist the request as `accepted`, append `request_accepted`, then return `202`.
- Validation failures before persistence should return HTTP errors and not create database rows.
- If a validation failure happens after persistence, transition to `rejected`.
- `GET /v1/requests/{id}` returns attempts and current request state. Audit events are returned only if `?include=events` is present.
- Do not expose raw signed transactions in any API response.
- Do not expose private keys or secrets in errors, logs, metrics, or audit events.

## Implementation Milestones

Implement in this order. Each milestone should include tests before moving to the next.

### Milestone 1: Project Skeleton And Config

- Create source layout.
- Implement env parsing.
- Implement registry JSON loading and validation.
- Implement Fastify app with health, readiness, metrics, and OpenAPI.
- Add example registry.

Tests:

- Env parser validation.
- Registry validation and lookup behavior.
- Health/readiness route basics.

### Milestone 2: Database And Migrations

- Implement Kysely client.
- Implement migration runner.
- Create tables and indexes from this spec.
- Add repository helpers for requests, attempts, audit events, and nonce cursors.

Tests:

- Migration applies cleanly to Postgres.
- Idempotency uniqueness.
- Semantic duplicate uniqueness.
- Atomic state update plus audit event insert.

### Milestone 3: API Without Transaction Execution

- Implement TypeBox schemas.
- Implement common error handling.
- Implement `POST /v1/relay` validation and persistence.
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

### Milestone 5: Transaction Manager Core

- Implement per-chain worker loop.
- Implement nonce cursor initialization and reservation.
- Build and sign `runMacro` transaction.
- Estimate gas and fees.
- Send raw transaction and persist `pending` only after RPC acceptance.
- Poll receipt and confirmation depth.
- Finalize `confirmed` or `reverted`.

Tests:

- Mocked RPC send accepted path.
- Mocked RPC send rejected path to `submit_failed`.
- Local Anvil success path.
- Local Anvil revert path.
- Multiple queued requests reserve distinct nonces before confirmations.

### Milestone 6: Robustness And Recovery

- Implement retry classification.
- Implement rebroadcast of known raw tx on uncertain RPC state.
- Implement dropped detection.
- Implement simple replacement policy from `transaction-policy.md`.
- Implement startup recovery for non-terminal requests/attempts.

Tests:

- RPC timeout then retry.
- Receipt missing but tx known remains `pending`.
- Receipt missing and tx unknown eventually `dropped`.
- Restart with pending tx resumes receipt polling.
- Replacement creates new attempt and marks previous attempt `replaced`.

### Milestone 7: Observability And Operational Polish

- Implement Prometheus metrics from the main spec.
- Add structured logs with request id, chain id, nonce, tx hash, macro, signer, provider, and attempt id.
- Add production smoke test command guarded by explicit env flag.

Tests:

- Metrics endpoint exposes expected metric names.
- Key paths increment counters/histograms.
- Production smoke test refuses to run without opt-in env.

## Test Phases

- Unit tests: pure logic and mocked RPC. Must be fast and run by default.
- Integration tests: real Postgres via Testcontainers or Compose. Run in CI.
- Local chain tests: Anvil-based end-to-end tests. Run in CI if stable enough; otherwise run in nightly/manual workflow.
- Fork tests: focused compatibility suite. Manual or scheduled, not required for every PR.
- Production-network smoke tests: manual only, guarded by explicit opt-in and small-value safe transactions.

## Handoff Checklist

Before implementation starts, ensure:

- `package.json`, `tsconfig.json`, Dockerfile, and Compose files exist.
- `specs/initial-provider-plan.md`, `specs/implementation-plan.md`, `specs/transaction-policy.md`, and `specs/operations.md` exist.
- v1 scope is `clearMacroV1` execution; Permit2 may remain schema/config-disabled until explicitly scheduled.
- Implementer understands that local-only steps are audit events, not public API states.
- Implementer understands that transaction submission and transaction confirmation are separate durable phases.
