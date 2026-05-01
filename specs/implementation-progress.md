# Implementation progress & interpretation notes

This document logs **decisions and interpretations** where the simplified public spec (`specs/simplified-dapp-facing-relay-api.md`) leaves room for ambiguity, plus **progress** on aligning code with that spec.

## Resolved interpretations

### `pending` vs `transaction.hash`

**Spec intent:** While public state is `pending`, the `transaction` object is absent until a hash exists; once a hash is known, state becomes `submitted` and `transaction.hash` is set in the **same persistence step** so clients never see `pending` with a hash.

**Dashboard spec** still mentions “no explorer link unless `transaction.hash` exists” in `pending`; that is treated as **defensive UI only** for inconsistent snapshots, not a first-class API state.

### Duplicate visibility (`200` vs `409`)

**Implementation meaning:** “Visible to the caller” = same **`client_id`** as the row stored on the existing execution (derived from API token, or `anonymous` when auth is disabled).

- **Auth enabled, same client:** `200` + existing execution body.
- **Auth enabled, different client:** `409 DUPLICATE_EXECUTION`, `executionId: null`.
- **Auth disabled (`anonymous` only):** same digest ⇒ always same `client_id` ⇒ **`200`** replay; `409` does not apply across tenants because tenants are not distinguishable without auth.

### `rejected` terminal

Reserved for **post-creation** deterministic failures (e.g. worker optional safety check, relayer intent rejected as a deterministic policy outcome). Synchronous create failures remain HTTP errors with **no** public execution.

If no such paths fire in production, `rejected` may stay rare; tests still cover at least one worker-driven path.

### Relayer ↔ chain binding

Spec: discover OZ relayer per registry `chainId` by querying the relayer API and matching EVM chain id.

**Implementation:** `GET /api/v1/relayers` (paginated) + per-id `GET /api/v1/relayers/:id` + `GET /api/v1/networks/:networkType:network` to read network metadata; parse `eip155:<chainId>` from network `id` when present. **Startup fails** if zero or multiple relayers match a configured chain (no registry `ozRelayerId` override).

### Readiness vs capabilities

- **`GET /v1/capabilities`:** only `providerName` + `chains[].chainId` + `chains[].forwarderAddress` (per spec).
- **`GET /readyz`:** operational readiness across configured chains (uses registry RPCs + relayer binding).

## Open / follow-ups

- Confirm real OZ network payloads in staging if `network.id` is not `eip155:*` for some deployments; extend matcher if needed.
- Optional env `SENSITIVE_AUDIT_LOGGING` (not in spec): default off; never log raw payload/signature in audit rows.

## Test harness notes

- Integration tests use a **stub OpenZeppelin client** and default **`preflightRunMacro → ok`** so `POST` does not require a live chain RPC. Tests that need real preflight behavior override `preflightRunMacro` explicitly.

## Test / coverage status (v8)

- **`pnpm test`** — unit, integration, and **`test/e2e`** relay journeys (HTTP + one full worker path to `succeeded`).
- **`pnpm test:coverage`** — typically **~84%** statements across `src/`; largest remaining gaps are **`readiness.ts`** (real RPC fallbacks) and some **`routes.ts`** branches (e.g. rare error paths). Full RPC + live relayer matrix belongs in staging / `RUN_ANVIL_TESTS=1`, not required for CI gate.

## Changelog

- _Created with simplified relay API implementation._
- Docs sweep: root **`README.md`**, **`specs/README.md`**, **`specs/operations.md`**, **`config/oz-relayer/README.md`**, superseded banners on older API/plan specs; **`test/e2e/`** HTTP + worker journeys; extra unit/integration coverage (`builder`, `validation-registry`, `listRelayerIds`).
