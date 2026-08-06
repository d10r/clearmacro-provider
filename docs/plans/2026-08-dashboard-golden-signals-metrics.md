> **Iteration plan** — frozen 2026-08-06. Not maintained after ship.
> Current docs: [operations.md](../operations.md), [architecture.md](../architecture.md), alerting plan [2026-08-unexpected-failure-alerting.md](./2026-08-unexpected-failure-alerting.md)

# Dashboard / Golden-Signals Metrics

## Goal

Wire **complementary, dashboard-oriented metrics** so Grafana can show traffic, error mix, worker funnel, readiness, latency, and stall age — without changing the paging contract from the unexpected-failure alerting plan.

This iteration is **observe and graph**, not page. Paging remains:

- `clearmacro_actionable_failures_total` (catch-all, excluding `RELAYER_RATE_LIMITED`)
- Sustained `clearmacro_operational_retries_total`
- Signer balance gauges (existing)
- Infra `up == 0`

## Relationship to alerting metrics

| Concern | Alerting plan | This plan |
|---------|---------------|-----------|
| “Something broke — notify” | Actionable failures + operational retries | Do not duplicate as pager |
| “How busy are we?” | — | Request + terminal outcome rates |
| “What are clients doing wrong?” | Explicitly excluded from pager | Validation failure counter |
| “Where in the funnel?” | Terminal submit/poll failures only | Submission outcomes + poll latency |
| “Can we admit work?” | Only after a failed admit | Readiness gauge (proactive) |
| “Is work stuck silently?” | Retries when backoff fires | Oldest non-terminal execution age |

All metrics in this plan are **complementary**. Do not remove or weaken actionable/operational counters.

## Constraints and non-goals

- Do **not** turn client validation volume into Alertmanager pages by default.
- Do **not** expose execution IDs, payloads, signatures, addresses, or free-text as labels.
- Do **not** expose OpenZeppelin Relayer IDs as metric labels — use `chain_id` (retarget stubs that used `relayer_id`).
- Do **not** scrape OZ Relayer `/metrics` in this iteration.
- Do **not** redesign gas funding / balance thresholds.
- Do **not** require checking in Grafana JSON for app acceptance; document panel intents + PromQL in `operations.md`.
- Keep cardinality bounded: `chain_id`, small enums.
- Prefer instrumenting existing decision points. Oldest-age uses a cheap periodic DB query; readiness sampling must reuse/share probes (no duplicate full readiness storms).
- Metrics are process-local best-effort (crash window OK). No durable outbox.

## Metrics to wire / add

### 1. `clearmacro_requests_total` (existing stub — wire)

```text
clearmacro_requests_total{chain_id, kind, result}
```

**Coverage:** exactly **once** per schema-valid `POST /v1/relay-executions` that reaches the authenticated route handler (after Fastify schema validation). Wrap auth → admit → finalize → response construction so one result is always recorded (including unexpected throws → `error`).

Malformed bodies rejected by schema (never enter handler) are **out of scope** for this counter (no reliable `chain_id`/`kind`). Do not add a Fastify global hook for them in this iteration.

- `kind`: request `kind` when known; if somehow missing after schema, `unknown`
- `chain_id`: decimal string from body; `unknown` only if unavailable
- `result` (exhaustive for handler outcomes):
  - `created` — new execution created
  - `duplicate` — same-client dedup replay returned existing execution (`200` with existing id)
  - `rejected_client` — expected client/validation/policy/signature/preflight-user / `DUPLICATE_EXECUTION` (cross-client) / `UNAUTHORIZED`
  - `rejected_provider` — readiness / `CHAIN_UNAVAILABLE` / `RELAYER_UNAVAILABLE` / `RELAYER_RATE_LIMITED` / other provider admit failures
  - `error` — unexpected throw / `INTERNAL_ERROR`

Map via a small helper from HTTP outcome + `ApiError.code`.

**Instrumentation:** route handler in [`routes.ts`](../../src/api/routes.ts) (preferred choke point), not only deep inside `admitRelayExecution` (misses auth/finalize/throws).

### 2. `clearmacro_validation_failures_total` (existing stub — retarget + wire)

```text
clearmacro_validation_failures_total{chain_id, code}
```

- Add `chain_id` (breaking unused stub is fine).
- Increment for **expected client-facing** codes only:  
  `VALIDATION_ERROR`, `INVALID_CLEAR_MACRO_PAYLOAD`, `PROVIDER_NOT_ALLOWED`, `MACRO_NOT_ALLOWED`, `CHAIN_NOT_ALLOWED` (admission), `CLEAR_MACRO_EXPIRED`, `CLEAR_MACRO_NOT_YET_VALID`, `SIGNATURE_INVALID`, `PREFLIGHT_REVERTED`, `DUPLICATE_EXECUTION`, `UNAUTHORIZED`.
- Do **not** use audit-only names like `DUPLICATE_HIDDEN`.
- Do **not** increment for actionable admission codes.

### 3. `clearmacro_relayer_submission_total` (retarget + wire)

```text
clearmacro_relayer_submission_total{chain_id, outcome}
```

- Drop `relayer_id`.
- `outcome`: `accepted` | `retry` | `failed`
- Wire in [`worker.ts`](../../src/relayer/worker.ts) at submit accept / transient retry / exhausted fail (failed still also hits actionable).

### 4. `clearmacro_relayer_poll_duration_seconds` (retarget + wire)

```text
clearmacro_relayer_poll_duration_seconds{chain_id}
```

- Drop `relayer_id`.
- Time each OZ `getTransaction` attempt; `observe` in a `finally` so errors and 429s still record latency.
- Keep existing histogram buckets unless clearly wrong.

### 5. `clearmacro_readiness` (retarget + wire)

```text
clearmacro_readiness{chain_id, reason}
```

- Gauge: `1` = ready with `reason="none"`; `0` = not ready with `reason` = `PROVIDER_NOT_READY` | `RELAYER_UNAVAILABLE` | `RELAYER_RATE_LIMITED`.

**Stale label cleanup (required):** On every sample for a `chain_id`, **remove all prior labelsets** for that chain on this metric, then set the current `{chain_id, reason}` value. Otherwise old `reason` series linger and soft alerts false-fire. Test reason transitions (`RELAYER_UNAVAILABLE` → ready, and reason→reason).

**Sampler requirements:**

- Run once immediately at startup, then on interval (default 30s; env `READINESS_METRICS_INTERVAL_MS`, `0` disables).
- Sequential or tightly bounded concurrency across chains (do **not** fan out full OZ+RPC+balance probes for all chains in parallel).
- Reuse existing readiness evaluator + readyz success/rate-limit cache / single-flight where possible — do not launch a second independent expensive probe storm.
- No overlapping ticks; per-chain failures must not abort the whole tick.
- Export testable `sampleReadinessMetricsOnce(...)`.

Do not page on this gauge in the app PR; document soft alerts only **after** cleanup semantics above.

### 6. `clearmacro_executions_terminal_total` (new)

```text
clearmacro_executions_terminal_total{chain_id, state, code}
```

- Increment **once** on nonterminal → terminal only.
- `state`: `succeeded` | `reverted` | `failed` | `rejected` | `expired` | `canceled`
- `code`: from persisted error JSON when present; else `none`

**Single observer (required):** Instrument at the repository `transitionState` boundary (wrapper/decorator/hook) so worker, authorization worker, and API `finalizeCreatedExecution` (and any other callers) cannot miss increments. Use the returned row’s final state + `lastErrorJson`. Do not scatter ad-hoc increments only at some worker call sites.

### 7. `clearmacro_oldest_nonterminal_execution_age_seconds` (new)

```text
clearmacro_oldest_nonterminal_execution_age_seconds{chain_id, state}
```

- Age = `now - created_at` (seconds) of the oldest non-terminal row per `(chain_id, state)` for `awaiting_authorization` | `pending` | `submitted`.
- Name reflects **execution age**, not time-in-current-state (schema has no reliable state-entered-at).
- **Every tick:** for each registry `chain_id` × the three states, set the gauge to the computed age or **`0` if none** (so series do not go stale after drain). Alternatively remove missing series each tick — prefer explicit `0` for configured chains.
- Interval default 30–60s; env `OLDEST_NONTERMINAL_AGE_INTERVAL_MS`, `0` disables.
- Immediate first sample; no overlapping ticks; testable `sampleOldestNonterminalAgesOnce(...)`.

## Label migration

Changing label sets on previously unused stubs is fine. Do not emit `relayer_id`.

## Suggested Grafana panels (ops applies)

Extend Clear Macro dashboard conceptually:

1. Request rate by `result` / `chain_id`
2. Admit success ratio: `(created+duplicate) / all`
3. Validation failures by `code`
4. Actionable failures + operational retries (existing alerting metrics)
5. Submission outcomes
6. Poll latency p50/p95
7. Readiness by chain
8. Terminal outcomes by `state`
9. Oldest non-terminal execution age by `state`
10. Existing balance panels

## Soft alerts (document only)

Only valid with readiness stale-series cleanup:

```yaml
- alert: ClearMacroChainNotReady
  expr: clearmacro_readiness{reason!="none"} == 0
  for: 10m
  labels: { severity: warning }

- alert: ClearMacroExecutionStuck
  expr: max by (chain_id, state) (clearmacro_oldest_nonterminal_execution_age_seconds) > 1800
  for: 10m
  labels: { severity: warning }
```

No validation-volume pages by default.

## Testing (required)

### Helpers

- Reuse `test/fixtures/metrics.ts` `metricSampleValue`.
- Samplers must be unit/integration-testable via `*Once` functions without relying on timers.

### Unit

- Table-driven: request `result` mapping from codes/HTTP outcomes; validation-failure allowlist; confirm actionable codes are excluded from validation counter.

### Integration — requests / validation (route-level)

| Case | Assert |
|------|--------|
| Successful create | `requests_total{result="created"}` += 1 |
| Same-client dedup | `result="duplicate"` |
| Cross-client dedup / `DUPLICATE_EXECUTION` | `rejected_client` + validation `DUPLICATE_EXECUTION` |
| `UNAUTHORIZED` (auth enabled) | `rejected_client` + validation `UNAUTHORIZED` |
| `SIGNATURE_INVALID` | `rejected_client` + validation; actionable unchanged |
| `PROVIDER_NOT_READY` | `rejected_provider`; no validation; actionable still increments |
| Forced throw after admit entry | `result="error"` exactly once |

### Integration — worker funnel

| Case | Assert |
|------|--------|
| Submit accepted / retry / failed | `relayer_submission_total` outcomes |
| Poll including error/429 | histogram `_count` increases |
| Terminal success/revert/fail | `executions_terminal_total` once; re-poll no double-count |
| Auth worker terminal reject/fail | terminal counter increments (proves repo observer, not only relayer worker) |

### Integration — readiness + age samplers

| Case | Assert |
|------|--------|
| Stub not-ready then ready | old reason series gone; `reason="none"` value 1 |
| Reason A → reason B | only B remains for that chain |
| Planted old pending | age ≥ expected; after terminalize, age `0` for that state |
| Sampler continues after one chain probe throws | other chains still updated |

### Negative

- No `relayer_id` labels in exposition for these metrics.
- Success path: no validation_failures / no actionable bump.

## Implementation sketch

1. Retarget stubs + add terminal/age metrics in [`metrics.ts`](../../src/metrics/metrics.ts).
2. Helpers: `src/metrics/requestOutcomes.ts` (result + validation allowlist).
3. Route-level request recording in [`routes.ts`](../../src/api/routes.ts).
4. Repo-level terminal observer on `transitionState`.
5. Worker: submission outcomes + poll histogram `finally`.
6. Readiness metrics sampler (shared evaluator/cache, sequential, remove stale labels).
7. Oldest-age sampler + repository query.
8. Env knobs; wire in [`main.ts`](../../src/main.ts).
9. Tests + [`operations.md`](../operations.md) dashboard section.

## Acceptance criteria

- [ ] All seven metrics emit sample lines on exercised paths.
- [ ] Request counter: exactly one increment per schema-valid handler invocation (including error path).
- [ ] Validation counter uses API codes (`DUPLICATE_EXECUTION`, not audit-only names).
- [ ] No `relayer_id` labels; actionable paging taxonomy unchanged.
- [ ] Terminal counter once per nonterminal→terminal via repository observer (API + workers).
- [ ] Readiness sampler cleans stale reasons; age sampler zeros/clears drained states.
- [ ] Samplers: immediate first run, no overlap, per-chain failure isolation, `*Once` test hooks.
- [ ] Poll histogram observes in `finally`.
- [ ] Required tests green; `operations.md` updated.
- [ ] Grafana deploy / Alertmanager soft rules: ops follow-up, not app merge gates.

## Out of scope / follow-ups

- Grafana JSON provisioning
- Counting schema-invalid HTTP bodies
- HTTP admit latency histogram
- Sampler probe_success / last_update gauges (nice-to-have)
- OZ Relayer scrape
- Durable exact-once metric outbox
