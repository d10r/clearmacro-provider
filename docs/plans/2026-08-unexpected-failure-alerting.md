> **Iteration plan** — frozen 2026-08-06. Not maintained after ship.
> Current docs: [operations.md](../operations.md), [architecture.md](../architecture.md), [README.md](../../README.md)

# Unexpected Failure Alerting Metrics

## Goal

Make **actionable / unexpected provider failures** visible to the existing Prometheus → Grafana → Alertmanager stack so operators get a notification when the service needs human attention.

Today those failures are persisted in SQLite (`relay_executions`, `create_request_audit_log`, lifecycle events) but most Prometheus counters in [`src/metrics/metrics.ts`](../../src/metrics/metrics.ts) are never written. The only live app series are signer-balance gauges (gas headroom is already covered elsewhere and is **out of scope** for this plan).

After this iteration:

1. A catch-all PromQL rule on `clearmacro_actionable_failures_total` notifies on terminal/decided actionable failures (excluding blippy rate limits).
2. A small second signal covers **non-terminal operational stalls** (indefinite retries) that never reach a terminal counter.
3. Process liveness (`up == 0` / scrape failure) remains an infra concern outside the app counter.

## Problem

Examples that currently leave no alertable metric trail:

- Admission rejected because configured app RPCs are down (`CHAIN_UNAVAILABLE`) or readiness says the chain is not ready (`PROVIDER_NOT_READY`, `RELAYER_UNAVAILABLE`).
- Relayer submission exhausted after retries (`RELAYER_SUBMIT_FAILED`), including insufficient signer gas that slipped past readiness (dust balance still `> 0`).
- OpenZeppelin Relayer reports non-revert failure (`RELAYER_FAILED`).
- Worker tick throws (`Relayer worker tick failed` in [`main.ts`](../../src/main.ts)) with no counter.
- Worker/auth paths that **retry forever** (preflight RPC unavailable, OZ poll errors/429, retryable Safe API errors) never terminalize, so a terminal-only counter would miss them.

Expected user/client outcomes (bad signature, policy reject, deterministic preflight revert, ordinary onchain user revert) must **not** page by default.

## Constraints and non-goals

- **Do not** redesign gas-wallet threshold / funding. Balance gauges and funding tooling already exist; keep them. This plan only ensures failures that still occur (including underfunded-but-nonzero cases) emit alertable series.
- **Do not** require scraping OpenZeppelin Relayer’s private `/metrics` port in this iteration. Mirror provider-visible OZ outcomes into app metrics instead.
- **Do not** expose execution IDs, payloads, signatures, or OZ transaction IDs as metric labels.
- **Do not** build a full golden-signals dashboard in this iteration (latency histograms, HTTP p95, full request matrices). Notification-first.
- **Do not** make cleanup of unrelated unused metric stubs a P0 gate. Leave dead HELP series alone unless touching that file anyway; optional follow-up.
- **Do not** introduce durable “preflight succeeded” persistence for P0. Terminal provider/relayer codes are enough; broad post-preflight revert paging is rejected (see below).
- Keep label cardinality bounded: `chain_id`, small enums for `stage` / `code` / `reason`. No free-text messages as labels.
- Prefer incrementing counters at the moment the failure is decided (API error return, terminal transition, or retry/backoff decision), not by scraping SQLite.

## Definition: actionable failure

An **actionable failure** is any failure where operators are expected to do something (top up gas, fix RPC config, unstick/pause OZ, investigate a provider bug), as opposed to a normal client/user outcome.

Classification is **`(stage, code)`**, not code alone. The same code can be expected at admission and actionable in the worker.

### P0 — increment `clearmacro_actionable_failures_total`

| Stage | Code | Notes |
|-------|------|--------|
| `admission` | `PROVIDER_NOT_READY` | Signer/RPC/readiness; chain cannot admit work |
| `admission` | `RELAYER_UNAVAILABLE` | OZ binding/paused/down |
| `admission` | `CHAIN_UNAVAILABLE` | App RPC / digest / signature-validation RPC path failed |
| `worker_submit` | `RELAYER_SUBMIT_FAILED` | Submit retries exhausted (gas, OZ HTTP, etc.) |
| `worker_poll` | `RELAYER_FAILED` | OZ terminal failure without clear user-revert signal |
| `worker_submit` / `worker_poll` / `authorization` | `INTERNAL_INVARIANT`, `INVALID_PERMIT2_STATE`, `INVALID_AUTHORIZATION_STATE` | Provider bug / corrupt state |
| `worker_submit` | `CHAIN_NOT_ALLOWED` | Config/registry invariant inside worker (not a client typo) |
| `authorization` | Non-retryable Safe infra terminal codes (e.g. `SAFE_API_UNAUTHORIZED`) | Credentials/config |
| `worker_tick` | `RELAYER_WORKER_TICK_FAILED` / `AUTHORIZATION_WORKER_TICK_FAILED` | Uncaught tick exception; catch workers **separately** |

### Meter but do **not** include in the catch-all alert

| Stage | Code | Alerting |
|-------|------|----------|
| `admission` | `RELAYER_RATE_LIMITED` | Still increment actionable counter for investigation, but **exclude** from catch-all; use sustained-threshold alert only |

### Expected — do **not** increment the actionable counter

- Admission: `VALIDATION_ERROR`, `INVALID_CLEAR_MACRO_PAYLOAD`, `PROVIDER_NOT_ALLOWED`, `MACRO_NOT_ALLOWED`, `CHAIN_NOT_ALLOWED`, `CLEAR_MACRO_EXPIRED`, `CLEAR_MACRO_NOT_YET_VALID`, `SIGNATURE_INVALID`, `PREFLIGHT_REVERTED`
- `DUPLICATE_REPLAYED` / `DUPLICATE_HIDDEN` / `CREATED`
- Terminal `reverted` with `ONCHAIN_REVERTED` / `RELAYER_REPORTED_REVERT` (ordinary user/onchain outcome; see follow-up)
- Worker re-preflight `PREFLIGHT_REVERTED` treated as user/policy reject
- `SAFE_AUTHORIZATION_UNSUPPORTED` (unsupported Safe shape — product limitation)
- `canceled` / `expired` from validity window alone

Optional later: wire stub `clearmacro_validation_failures_total` for client-error dashboards (non-paging).

### Rejected for P0: broad `POST_PREFLIGHT_FAILURE`

Do **not** page (or replace specific codes with) a catch-all “failed/reverted after successful preflight” code.

Reasons:

- Legitimate onchain races after a green simulation are common enough to cause alert fatigue.
- “Successful preflight was recorded” is not a durable field today; requiring it adds non-trivial state for little P0 value.
- Provider-fault paths after preflight already surface as `RELAYER_SUBMIT_FAILED` / `RELAYER_FAILED` / tick failures — keep those specific codes.

Follow-up (optional): a separate non-paging or high-threshold anomaly counter for post-submit `reverted` volume if ops wants trend visibility.

## Metrics

### P0a — primary paging counter

```text
clearmacro_actionable_failures_total{chain_id, stage, code}
```

- Type: Counter
- `stage`: `admission` | `worker_submit` | `worker_poll` | `authorization` | `worker_tick`
- `code`: stable machine code from the tables above
- `chain_id`: decimal string; use `unknown` only when no chain context (tick-level)

Increment **once** per decided event (one API error response, or one transition into a terminal actionable state, or one tick failure). Do not re-increment on poll loops for an already-terminal execution.

Worker-tick failures go on **this** counter (`stage=worker_tick`, codes above), not only a secondary metric — so one PromQL catch-all covers them. Catch relayer and authorization ticks in separate `.catch` handlers so the code label is accurate (`Promise.all` must not collapse identity).

### P0b — non-terminal operational retries / stalls

Terminal counters miss paths that backoff forever. Add a bounded retry/stall signal:

```text
clearmacro_operational_retries_total{chain_id, stage, reason}
```

- Type: Counter
- Increment when the worker/auth path schedules another retry for an operational reason (not user wait).
- Suggested `reason` values: `preflight_rpc_unavailable`, `relayer_poll_error`, `relayer_poll_rate_limited`, `safe_api_retryable`
- `stage`: `worker_preflight` | `worker_poll` | `authorization`

Alert on **sustained** rate (see below), not on a single increment.

Optional companion if easy from existing queries (nice-to-have in same PR if cheap, else follow-up):

```text
clearmacro_oldest_nonterminal_age_seconds{chain_id, state}
```

Gauge of oldest non-terminal execution age for `pending` / `submitted` / `awaiting_authorization`. Useful when retries are silent; not required if the retry counter + `for:` is enough for P0.

### Existing stubs

| Existing stub | This iteration |
|---------------|----------------|
| `clearmacro_requests_total` | Leave alone (optional later) |
| `clearmacro_validation_failures_total` | Leave alone (optional later) |
| `clearmacro_relayer_submission_total` | Optional wire for investigation; not required for paging if actionable counter covers `RELAYER_SUBMIT_FAILED` |
| `clearmacro_relayer_poll_duration_seconds` | Out of scope |
| `clearmacro_readiness` | Out of scope |
| Dead HELP-only series cleanup | **Not P0** |

### Instrumentation points

1. **Admission** — [`admitRelayExecution.ts`](../../src/api/admitRelayExecution.ts): on actionable `ApiError`, `inc` with `stage=admission`. Central helper so paths cannot forget metrics.
2. **Relayer worker** — [`worker.ts`](../../src/relayer/worker.ts):
   - Terminal actionable codes → `actionable_failures_total` once.
   - Retry/backoff for RPC unavailable / poll error / poll 429 → `operational_retries_total`.
3. **Authorization worker** — [`authorizationWorker.ts`](../../src/relayer/authorizationWorker.ts): terminal infra failures → actionable; retryable Safe API backoff → operational retries. Keep `clearmacro_safe_authorization_poll_total` as-is.
4. **Worker ticks** — [`main.ts`](../../src/main.ts): separate catches for relayer vs authorization → `actionable_failures_total{stage="worker_tick", code=...}`.

Classification lives in one module (e.g. `src/metrics/actionableFailures.ts`) keyed by `(stage, code)`, unit-tested.

## Alerting (ops reference — not app acceptance)

App acceptance is **correct metrics on `/metrics`**. Wiring Prometheus/Alertmanager is a separate ops step.

Suggested PromQL (for `operations.md`; not required to deploy in this PR):

```yaml
# Catch-all actionable failures, excluding rate-limit blips
- alert: ClearMacroActionableFailure
  expr: increase(clearmacro_actionable_failures_total{code!="RELAYER_RATE_LIMITED"}[5m]) > 0

# Sustained OZ rate limiting
- alert: ClearMacroRelayerRateLimited
  expr: |
    increase(clearmacro_actionable_failures_total{code="RELAYER_RATE_LIMITED"}[10m]) > 3
    or increase(clearmacro_operational_retries_total{reason="relayer_poll_rate_limited"}[10m]) > 3
  for: 5m

# Sustained non-terminal retries
- alert: ClearMacroOperationalRetries
  expr: sum by (chain_id, stage, reason) (increase(clearmacro_operational_retries_total[15m])) > 5
  for: 10m
```

Document that catch-all should use `code!="RELAYER_RATE_LIMITED"`. Do not claim alerts are live until ops deploys them.

## Testing (required in the implementation PR)

Automated tests are the proof that exposed metrics are correct. Implement them in this PR; reviewers (human or LLM) should treat failing or missing cases below as incomplete.

### Test helpers

1. Extend [`test/fixtures/harness.ts`](../../test/fixtures/harness.ts) to return `metrics` from `createApp` (already `{ app, metrics }`) so tests can read `await metrics.registry.metrics()` without only scraping HTTP — both are fine; prefer registry for precision and `GET /metrics` for at least one smoke that the route exposes samples.
2. Add a small parser helper (same style as [`test/unit/relayer-balance-sampler.test.ts`](../../test/unit/relayer-balance-sampler.test.ts) `metricValue`): given exposition text + metric name + label map → numeric value (or `undefined` if no sample line). Asserting HELP/TYPE alone is **not** sufficient.
3. Optionally allow `createTestHarness({ metrics })` override so worker-only tests can share one registry.

### Unit — classification

New file e.g. `test/unit/actionable-failures.test.ts`:

- Table-driven tests over `isActionableFailure(stage, code)` (or equivalent).
- Must cover: admission `CHAIN_NOT_ALLOWED` → false; worker `CHAIN_NOT_ALLOWED` → true; admission `SIGNATURE_INVALID` / `PREFLIGHT_REVERTED` → false; admission `PROVIDER_NOT_READY` / `CHAIN_UNAVAILABLE` / `RELAYER_UNAVAILABLE` / `RELAYER_RATE_LIMITED` → true; worker `RELAYER_SUBMIT_FAILED` / `RELAYER_FAILED` / invariants → true; `ONCHAIN_REVERTED` → false.

### Integration — admission → `/metrics`

New or extended file under `test/integration/` (API harness):

| Case | Setup | Assert |
|------|--------|--------|
| Ready failure | `getChainReadiness → { ready:false, reasonCode:"PROVIDER_NOT_READY" }`, POST create | actionable counter `stage=admission,code=PROVIDER_NOT_READY,chain_id=1` == 1 |
| RPC-style | force path that returns `CHAIN_UNAVAILABLE` (existing harness override patterns) | same counter with that code == 1 |
| Expected reject | `validateRelaySignature → false` | actionable counter for that request **absent or unchanged** |
| Preflight user revert | `preflightRunMacro → "deterministic_revert"` | actionable **not** incremented |
| Rate limit | readiness `RELAYER_RATE_LIMITED` | actionable **is** incremented (still metered); document catch-all exclusion in ops only |

After each actionable case, `GET /metrics` (or registry text) must contain a **sample line**, not only `# HELP` / `# TYPE`.

### Integration — relayer worker

Drive `processRelayerWorkerTick` with stubbed deps/repos (follow [`test/integration/`](../../test/integration/) worker tests):

| Case | Assert |
|------|--------|
| Submit retries exhausted → `RELAYER_SUBMIT_FAILED` | actionable `stage=worker_submit` == 1 |
| Poll projects `RELAYER_FAILED` | actionable `stage=worker_poll` == 1 |
| Same terminal execution polled again | counter stays 1 (idempotent) |
| Ordinary `ONCHAIN_REVERTED` / `RELAYER_REPORTED_REVERT` | actionable **not** incremented |
| Preflight returns `rpc_unavailable` (retry, non-terminal) | `operational_retries_total{reason="preflight_rpc_unavailable"}` += 1; no false terminal actionable |
| Poll 429 / poll error → retry | `operational_retries_total` with `relayer_poll_rate_limited` / `relayer_poll_error` |

### Integration — authorization worker (if Safe path touched)

- Non-retryable Safe infra terminal → actionable `stage=authorization`
- Retryable Safe API backoff → `operational_retries_total{reason="safe_api_retryable"}`
- `SAFE_AUTHORIZATION_UNSUPPORTED` → not actionable

### Integration / unit — worker ticks

Cover separate catch paths (extract tick runners if needed for testability):

- Relayer tick throw → `actionable_failures_total{stage="worker_tick",code="RELAYER_WORKER_TICK_FAILED"}`
- Authorization tick throw → `...code="AUTHORIZATION_WORKER_TICK_FAILED"`
- Combined `Promise.all` must not attribute both failures to one code

### Negative / cardinality smoke

- Successful create + success path: no unexpected actionable increments.
- Labels only use bounded enums from this plan (no execution ids, messages, or addresses).

## Implementation sketch

1. Add `actionableFailureCounter` + `operationalRetryCounter` in [`metrics.ts`](../../src/metrics/metrics.ts).
2. Add `(stage, code)` classification helper + `recordActionableFailure` / `recordOperationalRetry`.
3. Thread `metrics` into relayer worker deps (authorization worker already has a metrics slice).
4. Split worker tick error handling in [`main.ts`](../../src/main.ts) so each worker records its own tick failure code.
5. Implement the **Testing** section above in the same PR.
6. Update [`docs/operations.md`](../operations.md) with counters, taxonomy, and example alert expressions (documented, not claimed deployed).

## Acceptance criteria

App PR is done when metrics behavior is correct and covered by automated tests:

- [ ] Admission actionable failures produce sample lines on `clearmacro_actionable_failures_total` (registry and/or `GET /metrics`).
- [ ] `RELAYER_SUBMIT_FAILED` and `RELAYER_FAILED` each increment once with the specific code; re-poll does not double-count.
- [ ] Expected client failures (`SIGNATURE_INVALID`, admission `PREFLIGHT_REVERTED`, admission policy rejects) do **not** increment the actionable counter.
- [ ] Ordinary terminal `reverted` (`ONCHAIN_REVERTED` / `RELAYER_REPORTED_REVERT`) does **not** increment the actionable counter.
- [ ] Relayer and authorization tick failures increment distinct `worker_tick` codes.
- [ ] Non-terminal operational retries increment `clearmacro_operational_retries_total` with the documented reasons.
- [ ] `RELAYER_RATE_LIMITED` is metered on the actionable counter; ops docs note catch-all should exclude it.
- [ ] Required unit + integration tests from **Testing** are present and green in CI.
- [ ] No new high-cardinality labels; gas-balance / funding flows unchanged.
- [ ] Unused stub cleanup is not required to merge.

Out of app acceptance: Alertmanager rule deployment, scrape config, notification routing.

## Out of scope / follow-ups

- Deploying/verifying Alertmanager rules and `up == 0` (ops)
- Broad `POST_PREFLIGHT_FAILURE` / paging on ordinary post-sim `reverted`
- Persisting preflight-success flags for anomaly classification
- Per-chain readiness gauge + blackbox on `/readyz`
- Full request/latency dashboards; deleting dead metric stubs
- Scraping OZ Relayer metrics from the Docker network
- Durable metric outbox if crash-window loss becomes unacceptable
