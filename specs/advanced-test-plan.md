# ClearMacro Provider Backend: Advanced Test Plan

## Goal

Define advanced test suites that harden the ClearMacro Provider beyond the milestone-level coverage in `specs/implementation-plan.md`.

This plan focuses on correctness under concurrency, partial outages, policy complexity, schema evolution, and OpenZeppelin Relayer adapter compatibility. It is intentionally layered so fast/high-value tests can run during v1 implementation while expensive stress and upgrade tests wait until the baseline is stable.

## Scope

These tests are additive. They do not replace milestone tests from the implementation plan and do not introduce new runtime features.

Advanced suites in this document:

1. Concurrency and race-condition tests.
2. Readiness matrix and degraded-mode tests.
3. Auth and client policy negative tests.
4. Preflight edge-case and classification tests.
5. State-machine invariants and property tests.
6. Migration compatibility and upgrade-path tests.
7. OpenZeppelin Relayer adapter contract tests.
8. ABI and ClearMacro fixture compatibility tests.

## Test Environment Strategy

Use a layered strategy so fast tests run often and expensive tests run on gated schedules.

- Unit/property tests with small deterministic seeds: run on every PR.
- Integration tests (SQLite + mocked relayer/RPC): run on every PR.
- Local-chain tests (Anvil + OZ Relayer + Redis): run in CI if stable; otherwise nightly.
- Upgrade fixture tests: nightly + release candidates once there is a released schema to upgrade from.
- Stress/concurrency suites: nightly and before production rollout.

Do not add Docker-only tests to the default `pnpm test` path. Docker-dependent tests should have explicit commands or CI jobs.

## Suite A: Concurrency and Race Conditions

### Objectives

- Verify idempotency and semantic duplicate protections under parallel load.
- Verify worker claim/submit logic does not create duplicate submissions.
- Verify request terminality and audit consistency under concurrent poll/update.

### Required Scenarios

1. **Parallel idempotent replay**
   - Send N parallel `POST /v1/relay` requests with same client, same idempotency key, same body.
   - Expect exactly one row in `relay_requests`.
   - Expect all responses reference the same `requestId` (or first accepted + deterministic replay behavior).

2. **Parallel idempotency conflict**
   - Send N parallel requests with same client and idempotency key but different body hashes.
   - Expect exactly one canonical winner; others return `409 IDEMPOTENCY_CONFLICT`.
   - Confirm no second request row is created.

3. **Parallel semantic duplicates without idempotency key**
   - Send N parallel requests with identical semantic tuple `(chain_id, forwarder, macro, signer, clear_macro_nonce)`.
   - Expect one accepted request; duplicates rejected as configured.
   - Validate DB uniqueness violation is translated to stable API error code.

4. **Worker claim resistance**
   - Run two worker loops concurrently against the same SQLite DB in a test harness.
   - This is a defensive test for accidental duplicate workers, not a requirement to support horizontally scaled app instances in v1.
   - Ensure each request is submitted to relayer at most once in the normal success path.
   - Confirm audit events show one submit path per request.

5. **Poll-update contention**
   - Simulate concurrent relayer status polls for same `oz_transaction_id`.
   - Ensure no invalid transitions and no duplicate terminal transitions.

### Exit Criteria

- Zero duplicate relayer submissions for a request.
- No illegal state transitions.
- Deterministic API errors under contention.
- No requirement is created for multi-process distributed queue semantics beyond SQLite transactional claiming.

## Suite B: Readiness Matrix and Degraded Modes

### Objectives

- Validate global `/readyz` semantics and per-chain request acceptance behavior.
- Validate error-code accuracy under partial dependency outages.

### Required Matrix

Cover at least these dimensions:

- SQLite: available/open failure/write failure.
- Chain enabled: true/false.
- App RPC health per chain: healthy/unhealthy.
- OZ relayer health: healthy/unhealthy.
- Signer gas balance: >0 / 0.
- Confirmation alignment: aligned/misaligned.

### Required Assertions

1. `/readyz` fails when any enabled chain is not ready.
2. `POST /v1/relay` for chain X succeeds if chain X is ready, even if chain Y is unready, unless shared dependencies are down.
3. Disabled chain returns `403 CHAIN_NOT_ALLOWED`.
4. Enabled-but-unready chain returns `503 PROVIDER_NOT_READY` or `503 RELAYER_UNAVAILABLE` per policy.
5. SQLite open/write failure causes global unavailability and no partial request persistence.

### Exit Criteria

- Every tested matrix row has a single expected HTTP code and state outcome.
- No scenario returns ambiguous 500-class errors for known dependency failures.

## Suite C: Auth and Client Policy Negative Coverage

### Objectives

- Verify auth behavior is strict and policy scoping is enforced.
- Verify idempotency namespace behavior differs correctly with auth enabled/disabled.

### Required Scenarios

1. Missing bearer token when auth is enabled -> `401 UNAUTHORIZED`.
2. Invalid token hash match -> `401 UNAUTHORIZED`.
3. Disabled client -> `403 CLIENT_NOT_ALLOWED`.
4. Client not allowed for chain/provider/macro -> `403 CLIENT_NOT_ALLOWED`.
5. Auth disabled shared namespace behavior:
   - Two callers reusing same idempotency key and body map to same anonymous scope behavior.
6. Auth enabled isolated namespace behavior:
   - Same idempotency key reused by different clients does not conflict unless request semantics collide.

### Exit Criteria

- No auth bypasses.
- Policy-denied requests never create accepted rows.

## Suite D: Preflight Edge Cases and Classification

### Objectives

- Validate deterministic classification between `preflight_failed`, retriable queued behavior, and terminal submit failures.
- Validate RPC failover and fallback behavior in preflight path.

### Required Scenarios

1. Deterministic revert in simulation -> terminal `preflight_failed`.
2. RPC timeout on first endpoint, success on second -> request continues, no terminal failure.
3. All RPCs unavailable before persistence -> `503 CHAIN_UNAVAILABLE`.
4. All RPCs unavailable after persistence -> remains `queued`, audit event appended, later retry succeeds.
5. Preflight pass followed by real onchain revert -> final `reverted` (not `preflight_failed`).
6. Preflight disabled by config, if such a switch exists later -> request may submit without simulation and still finalizes through relayer status.

### Exit Criteria

- Each failure mode maps to the exact intended state/error code.
- RPC endpoint names (not URLs) appear in logs/audit details where relevant.

## Suite E: State-Machine Invariants and Property Tests

### Objectives

- Guarantee lifecycle correctness independent of specific test fixtures.
- Detect accidental regressions in transition logic.

### Invariants

1. Terminal states never transition.
2. Every persisted state transition is in the allowed transition set.
3. `terminal=1` if and only if state is terminal.
4. `terminal_at` is set exactly once for terminal transitions.
5. `current_tx_hash` changes only via relayer status projection.
6. Request and audit updates in a transition are atomic.

### Property Tests

- Generate random valid sequences of relayer status updates and transient polling errors.
- Project them through lifecycle mapper.
- Assert invariants hold for all generated sequences.

### Exit Criteria

- Invariant suite passes across randomized seeds in CI.
- Any counterexample emits a reproducible seed.

## Suite F: Migration Compatibility and Upgrade Path

### Objectives

- Ensure schema changes remain forward-safe and operationally predictable.
- Ensure migration runner behavior is deterministic and idempotent.

### Required Scenarios

1. Fresh DB migration from empty file -> latest schema.
2. Re-running migrations on latest schema is a no-op.
3. Upgrade from previous released schema fixtures with realistic data once a previous release exists:
   - accepted, queued, pending, terminal requests;
   - relayer_transactions rows;
   - audit_events history.
4. Upgrade with representative table sizes to assess lock times and migration runtime.
5. Roll-forward recovery:
   - interrupted migration process is recoverable by rerun (no corruption).

### Data Fixture Requirements

- Store versioned SQLite fixtures in `test/fixtures/migrations/`.
- Include synthetic edge rows (null/optional fields, high metadata volume, long error payloads).

### Exit Criteria

- No data loss in upgraded fixtures.
- All indexes/constraints present post-upgrade.
- Application boots and worker resumes with upgraded DB.

## Suite G: OpenZeppelin Relayer Adapter Contract

### Objectives

- Prevent drift between the app's relayer client and the OpenZeppelin Relayer API shape observed in the spike.
- Validate adapter behavior without depending on a live relayer for every PR.

### Required Scenarios

1. Submit transaction success:
   - Mock `POST /api/v1/relayers/{ozRelayerId}/transactions` returning `success: true` and an `OzTransaction`.
   - Expect `oz_transaction_id` persisted and request transitions to `pending`.
2. Submit transaction 4xx:
   - Mock relayer validation error.
   - Expect `submit_failed` after non-retryable classification.
3. Submit transaction transient failures:
   - Mock timeout/429/5xx followed by success.
   - Expect retry and one persisted relayer transaction ID.
4. Poll status mapping:
   - Mock `pending`, `submitted`, `confirmed`, `failed` with revert reason, `failed` without revert reason, `canceled`, and `expired`.
   - Expect canonical request states from `specs/implementation-plan.md`.
5. Relayer details/readiness:
   - Mock relayer details with `paused`, `system_disabled`, missing address, and usable address variants.
   - Expect readiness classification and signer-balance checks to use the returned address.
6. Raw relayer JSON retention:
   - Ensure raw relayer payload is stored internally in `relayer_transactions.raw_json`.
   - Ensure raw relayer payload is not returned in public request status responses.

### Exit Criteria

- Adapter tests define the app's supported OZ API subset.
- A breaking API-shape change fails tests before runtime.

## Suite H: ABI and ClearMacro Fixture Compatibility

### Objectives

- Ensure the app encodes and decodes ClearMacro data exactly as the contracts expect.
- Prevent drift from `IClearMacroForwarderV1.sol`.

### Required Scenarios

1. Payload decode fixture:
   - Use known ABI-encoded `IClearMacroForwarderV1.Payload` fixture.
   - Assert `action.params`, `security.domain`, `security.macroContract`, `security.provider`, `validAfter`, `validBefore`, and `nonce` are decoded correctly.
2. `runMacro` calldata fixture:
   - Encode `runMacro(macro, params, signer, signature)` and compare to a checked fixture generated from viem or Foundry.
3. Digest/signature validation fixture:
   - Mock or fork-call `getDigest(macro, params)`.
   - Assert EOA signature recovery validates the expected signer.
4. Invalid signer fixture:
   - Same payload with a signature from another key -> `SIGNATURE_INVALID`.
5. Provider `self` fixture:
   - Payload with `security.provider = "self"` -> rejected before persistence.

### Exit Criteria

- ABI fixtures pass without requiring a live production chain.
- Any future contract ABI mismatch is caught by fixture updates.

## CI and Execution Policy

Suggested job tiers:

- `test:core` (required on PR): baseline unit + integration + fast advanced subsets.
- `test:advanced` (nightly): full suites A-E and G-H with medium property seeds.
- `test:migrations` (nightly + RC): suite F with all fixtures.
- `test:soak` (manual/pre-release): high-volume concurrency and long-running worker tests.

Keep flaky tests quarantined but visible. No silent skips.

## Reporting and Artifacts

Each advanced suite should produce:

- Structured result summary (pass/fail + counts + duration).
- Failure artifacts: request/response payloads, relevant DB snapshots, and relayer mocks/log snippets.
- Reproduction command for each failed scenario.

Suggested output location:

```text
test-artifacts/advanced/
```

## Deferred Implementation Checklist

Before implementing this plan:

- Baseline v1 milestone tests must be green and stable.
- Worker lifecycle mapper must be finalized.
- A deterministic test harness for mocked RPC and relayer endpoints must exist.
- CI must support nightly jobs and artifact retention.

## Non-Goals

- This document does not introduce new runtime features.
- This document does not change the canonical request state machine.
- This document does not require multi-region or distributed-queue architecture changes.
- This document does not require public operator replacement/cancel APIs.
