# ClearMacro Provider: Production Hardening Test Plan

## Purpose

This document is the implementation checklist for hardening the current API defined in `specs/simplified-dapp-facing-relay-api.md`.

It is intentionally precise: each section names the implementation files, the test files, the expected assertions, and the command that must pass before moving on.

## Non-Goals

- Do not add backward-compatible migrations for pre-production schemas.
- Do not reintroduce `Idempotency-Key`.
- Do not reintroduce client-provided `forwarderAddress`.
- Do not reintroduce nonce-based semantic deduplication.
- Do not expose macros from `GET /v1/capabilities`.
- Do not expose OpenZeppelin Relayer IDs, transaction IDs, raw statuses, raw payloads, or raw signatures through public dapp API responses.
- Do not add client policy back into the provider registry.

## Required Verification Commands

Run these after every completed section:

```sh
pnpm run typecheck
pnpm test
```

Before marking the implementation production-ready, also run:

```sh
pnpm run build
```

## Section 1: Relayer Discovery Must Match OZ `chain_id`

### Risk

OpenZeppelin Relayer network responses expose the EVM chain ID as `chain_id`. The app must not rely only on synthetic `id` strings such as `eip155:1` or `evm:1`.

If discovery misses `chain_id`, startup/readiness can fail even when OZ Relayer is correctly configured.

### Implementation Files

- `src/config/relayerDiscovery.ts`
- `src/relayer/client.ts`

### Test Files

- `test/unit/relayer-discovery-bind.test.ts`
- `test/integration/relayer-client.test.ts`

### Required Tests

1. `parseEvmChainIdFromNetwork` returns `1` for:

```ts
{ chain_id: 1, id: "evm:mainnet", network_type: "evm", required_confirmations: 1 }
```

2. `parseEvmChainIdFromNetwork` still accepts fallback IDs:

```ts
{ id: "eip155:1", network_type: "evm", required_confirmations: 1 }
{ id: "evm:1", network_type: "evm", required_confirmations: 1 }
```

3. `bindRelayersToRegistry` binds a relayer when `getNetwork` returns `chain_id: 1`, even if `id` is not parseable as a numeric chain ID.

4. `bindRelayersToRegistry` still throws when zero active relayers match a configured chain.

5. `bindRelayersToRegistry` still throws when multiple active relayers match the same configured chain.

6. `OzRelayerClient.getNetwork` preserves `chain_id` from the OZ envelope.

### Command

```sh
pnpm test test/unit/relayer-discovery-bind.test.ts test/integration/relayer-client.test.ts
```

## Section 2: Duplicate Replay Must Require A Valid Signature

### Risk

Digest-based deduplication is a UX/retry feature, not an authorization bypass. A caller must not be able to retrieve or infer an existing execution by submitting an invalid signature for an existing digest.

### Implementation Files

- `src/api/routes.ts`
- `src/db/repositories.ts`

### Test Files

- `test/integration/api.test.ts`
- `test/e2e/relay-api.e2e.test.ts`

### Required Tests

1. First request with valid signature creates `202`.

2. Second request with same `(chainId, forwarderAddress, signerAddress, digest)` but invalid signature returns:

```text
422 SIGNATURE_INVALID
```

It must not return `200`.

3. Same request with valid signature still returns:

```text
200 existing execution
```

4. Cross-client duplicate with valid signature still returns:

```text
409 DUPLICATE_EXECUTION
error.executionId = null
```

5. The invalid-signature replay attempt writes an audit row with:

```text
outcome_code = SIGNATURE_INVALID
execution_id = null
```

6. The invalid-signature replay response must not leak the existing execution ID in the body.

### Command

```sh
pnpm test test/integration/api.test.ts test/e2e/relay-api.e2e.test.ts
```

## Section 3: Public Events Must Be Sanitized

### Risk

`include=events` is part of the public dapp API. It must not leak internal relayer IDs, OZ transaction IDs, raw OZ statuses, raw request payloads, or signatures.

### Implementation Files

- `src/api/routes.ts`
- `src/db/repositories.ts`
- `src/relayer/worker.ts`

### Test Files

- `test/integration/api.test.ts`
- `test/e2e/relay-api.e2e.test.ts`

### Required Tests

1. Create an execution, run a worker tick that appends a relayer submission event, then call:

```text
GET /v1/relay-executions/:id?include=events
```

2. Public events may include:

```ts
type PublicRelayExecutionEvent = {
  type: string;
  actor: string;
  reason: string;
  createdAt: string;
};
```

3. Public events must not include:

- internal event ID
- `executionId`
- `ozTransactionId`
- `ozRelayerId`
- raw OZ status
- raw OZ response JSON
- raw request payload
- raw signature
- `detailsJson` containing unsanitized internal fields

4. Internal DB rows may still keep unsanitized details for operations.

5. Add a regression assertion that the serialized public response string does not contain:

```text
ozTransactionId
ozRelayerId
oz-tx
relayer-main
signature
payload
```

### Command

```sh
pnpm test test/integration/api.test.ts test/e2e/relay-api.e2e.test.ts
```

## Section 4: Transient Submit Errors Must Not Produce Malformed Public Errors

### Risk

Transient submit failures are retry bookkeeping. They must not appear as malformed public `error` objects missing `category` or `retryable`.

### Implementation Files

- `src/relayer/worker.ts`
- `src/api/routes.ts`
- `src/db/repositories.ts`

### Test Files

- `test/integration/worker.test.ts`
- `test/integration/api.test.ts`

### Required Tests

1. Create a pending execution.

2. Configure relayer submit to throw a transient error such as:

```text
Relayer HTTP 503
```

3. Run one worker tick with `submitRetryCount > 1`.

4. Assert DB execution remains:

```text
state = pending
terminal = 0
```

5. Public `GET /v1/relay-executions/:id` must either omit `error` or include a schema-valid object:

```ts
{
  code: string;
  message: string;
  category: "user" | "provider" | "chain" | "relayer" | "unknown";
  retryable: boolean;
}
```

6. Public response must not expose internal retry bookkeeping as the public error object, for example:

```json
{ "code": "RELAYER_SUBMIT_ERROR", "message": "...", "submitAttempts": 1 }
```

7. After retry limit is reached, public error must be schema-valid and terminal:

```text
state = failed
error.code = RELAYER_SUBMIT_FAILED
error.category = relayer
error.retryable = false
```

### Command

```sh
pnpm test test/integration/worker.test.ts test/integration/api.test.ts
```

## Section 5: Registry RPC URL Semantics Must Be Explicit

### Risk

The registry schema allows `rpcUrls` to be omitted. The implementation must either support known chain defaults or reject missing RPCs at startup. Silent runtime failure is not acceptable.

### Implementation Files

- `src/config/schema.ts`
- `src/config/registry.ts`
- `src/chain/readiness.ts`

### Test Files

- `test/unit/registry.test.ts`
- `test/integration/readiness.test.ts`

### Required Tests

Choose one implementation strategy and test it.

Strategy A: require `rpcUrls` for now.

Tests:

1. Registry without `rpcUrls` fails `loadRegistry` with a clear error.
2. Registry with empty `rpcUrls` fails schema validation.
3. Registry with one valid RPC URL loads.

Strategy B: use known chain defaults.

Tests:

1. Registry without `rpcUrls` for a known viem chain creates clients using viem default RPCs.
2. Registry without `rpcUrls` for an unknown chain fails `loadRegistry` with a clear error.
3. Explicit `rpcUrls` override known defaults.

Until Strategy B is implemented completely, prefer Strategy A because it is simpler and operationally explicit.

### Command

```sh
pnpm test test/unit/registry.test.ts test/integration/readiness.test.ts
```

## Section 6: Required Confirmations Should Be Bound Once

### Risk

The app needs required confirmations to decide when a successful receipt becomes public `succeeded`, but fetching network metadata per create adds avoidable latency and another failure point.

### Implementation Files

- `src/config/relayerDiscovery.ts`
- `src/config/registry.ts`
- `src/api/routes.ts`
- `src/chain/readiness.ts`
- `src/relayer/mapper.ts`

### Test Files

- `test/unit/relayer-discovery-bind.test.ts`
- `test/integration/api.test.ts`
- `test/unit/lifecycle-mapper.test.ts`

### Required Tests

1. Relayer discovery stores both:

```text
relayerIdByChainId[chainId]
requiredConfirmationsByChainId[chainId]
```

or an equivalent runtime chain binding object.

2. `POST /v1/relay-executions` persists `required_confirmations` from the startup/readiness binding, not from a fresh per-request OZ network lookup.

3. If the matched OZ network omits `required_confirmations`, readiness/startup must fail unless an explicit operational fallback exists.

4. Lifecycle mapper keeps `submitted` for successful receipts until confirmations are satisfied.

5. Lifecycle mapper returns `succeeded` once OZ reports `confirmed_at` or equivalent confirmed status.

### Command

```sh
pnpm test test/unit/relayer-discovery-bind.test.ts test/integration/api.test.ts test/unit/lifecycle-mapper.test.ts
```

## Section 7: Public Response Contract Must Match The Simplified Spec

### Risk

The public API must remain dapp-simple. Regression tests should fail if old fields return.

### Implementation Files

- `src/api/routes.ts`
- `src/api/schemas.ts`

### Test Files

- `test/integration/api.test.ts`
- `test/e2e/relay-api.e2e.test.ts`

### Required Tests

1. `POST /v1/relay-executions` request schema rejects client-provided `forwarderAddress` if additional properties are disallowed, or ignores it if the framework permits unknown properties. The persisted and returned forwarder must always be registry-resolved.

2. Relay execution response does not include:

- `provider`
- `ozRelayerId`
- `ozTransactionId`
- `transaction.hashes`
- raw OZ status
- raw payload
- raw signature

3. `GET /v1/capabilities` returns exactly:

```ts
{
  providerName: string;
  chains: Array<{ chainId: number; forwarderAddress: string }>;
}
```

4. Capabilities response does not include:

- macros
- readiness
- feature flags
- public state names
- relayer IDs
- relayer statuses

### Command

```sh
pnpm test test/integration/api.test.ts test/e2e/relay-api.e2e.test.ts
```

## Section 8: Force Execution Semantics

### Risk

Force execution intentionally allows onchain reverts, but it must not bypass policy, auth, signature validation, expiry, readiness, or malformed payload checks.

### Implementation Files

- `src/api/routes.ts`
- `src/relayer/worker.ts`

### Test Files

- `test/integration/api.test.ts`
- `test/integration/worker.test.ts`

### Required Tests

1. Preflight deterministic revert without force returns:

```text
422 PREFLIGHT_REVERTED
```

and creates no public execution.

2. Preflight deterministic revert with force returns:

```text
202 pending
```

and marks internal/public metadata enough for debugging.

3. Worker does not re-run preflight and reject solely due to the same forced preflight revert.

4. Force does not bypass:

- invalid signature
- provider-name mismatch
- `(domain, macroAddress)` not allowlisted
- expired payload
- not-yet-valid payload
- chain readiness failure
- malformed payload

### Command

```sh
pnpm test test/integration/api.test.ts test/integration/worker.test.ts
```

## Section 9: Audit Log Coverage

### Risk

Failed authenticated create attempts must be traceable internally without creating public relay execution resources.

### Implementation Files

- `src/api/routes.ts`
- `src/db/repositories.ts`
- `src/db/migrations.ts`

### Test Files

- `test/integration/api.test.ts`
- `test/integration/db.test.ts`

### Required Tests

For each case below, assert one audit row is written with the expected `outcome_code`, and no public execution row is created unless stated otherwise:

1. `CHAIN_NOT_ALLOWED`
2. `INVALID_CLEAR_MACRO_PAYLOAD`
3. `PROVIDER_NOT_ALLOWED`
4. `MACRO_NOT_ALLOWED`
5. `CLEAR_MACRO_EXPIRED`
6. `CLEAR_MACRO_NOT_YET_VALID`
7. `CHAIN_UNAVAILABLE` during digest read
8. `SIGNATURE_INVALID`
9. `READINESS_UNAVAILABLE`
10. `PREFLIGHT_REVERTED`
11. `DUPLICATE_HIDDEN`
12. `DUPLICATE_REPLAYED`, with existing execution ID recorded
13. `CREATED`, with created execution ID recorded

Also assert audit rows do not store raw `payload` or raw `signature`.

### Command

```sh
pnpm test test/integration/api.test.ts test/integration/db.test.ts
```

## Section 10: Realistic E2E Smoke Path

### Risk

Stub-only tests can miss contract/RPC/OZ envelope mismatches.

### Implementation Files

- `src/main.ts`
- `src/chain/readiness.ts`
- `src/relayer/client.ts`
- `src/relayer/worker.ts`

### Test Files

- `test/integration/preflight-anvil.test.ts`
- `test/e2e/relay-stack.e2e.test.ts` (Docker stack; `pnpm run test:e2e:stack`)

### Required Tests

Fast default tests:

1. Preflight against Anvil contracts classifies deterministic revert as `deterministic_revert`.
2. Preflight against Anvil contracts classifies valid call as `ok`.
3. Signature validation supports EOA and ERC-1271 paths where fixtures exist.

Docker-gated full-stack tests (`pnpm run test:e2e:stack`; uses `RelayerLikePreflightForwarder` on chain **31337**, not full Superfluid protocol):

1. Start Redis, Anvil, OZ Relayer, and provider app.
2. Bind relayer by discovered OZ `chain_id`.
3. `GET /v1/capabilities` returns the configured provider name and forwarder.
4. `POST /v1/relay-executions` creates `202 pending`.
5. Worker submits through OZ Relayer.
6. Polling reaches `succeeded` or `reverted` depending on fixture.

### Command

Default (requires `anvil` on `PATH` for the preflight file):

```sh
pnpm test test/integration/preflight-anvil.test.ts test/integration/signature-validation.test.ts
```

Docker stack E2E (sets `RUN_STACK_E2E=1`; requires Docker, Compose, and fixture tooling—see `specs/operations.md`):

```sh
pnpm run test:e2e:stack
```

## Production Readiness Exit Criteria

The implementation can be considered ready for production review only when all are true:

- Sections 1 through 9 are implemented and covered by default `pnpm test`.
- Section 10 fast tests pass by default.
- Docker-gated stack tests either pass in CI/nightly or are explicitly documented as manual release checks.
- `pnpm run typecheck` passes.
- `pnpm test` passes.
- `pnpm run build` passes.
- No public response exposes `ozRelayerId`, `ozTransactionId`, raw OZ response JSON, raw payload, or raw signature.
