# OZ Relayer Spike Conclusion

## Viability Decision

- Decision: `adopt`
- Relayer version tested: `v1.4.0`
- Runtime mode: Docker Compose + Redis + Anvil

## Requirement Coverage

### 1) Burst Submission and Nonce Safety

- Evidence: `scenario1-burst-submission.json`
- Outcome: pass (with caveats)
- Notes:
  - accepted submissions: 20/20
  - submit failures: 0
  - nonce uniqueness/correctness: all final nonces distinct and within expected progression; order is not strictly submission order.

### 2) Lifecycle Status Mapping

- Evidence: `scenario1-burst-submission.json`, `scenario2-revert-handling.json`
- Outcome: pass
- Mapping confidence:
  - `pending`: covered (`pending`)
  - `confirmed`: covered (`confirmed`)
  - `reverted`: covered (`failed` + status_reason contains on-chain revert)
  - `submit_failed`: covered by HTTP failure handling paths in scripts (not observed in successful run)
  - `dropped/failed`: covered (`failed`, `canceled`)

### 3) Revert Handling

- Evidence: `scenario2-revert-handling.json`
- Outcome: pass
- Notes:
  - revert visibility in status/status_reason/error: explicit status `failed` + reason `Transaction reverted on-chain (receipt status: failed)`
  - receipt/hash availability: tx hash available

### 4) Restart Recovery

- Evidence: `scenario3-restart-recovery.json`
- Outcome: pass (with Redis repository mode)
- Notes:
  - initial run failed because repository storage defaulted to in-memory.
  - rerun with `REPOSITORY_STORAGE_TYPE=redis`, `RESET_STORAGE_ON_START=false`, and `STORAGE_ENCRYPTION_KEY` preserved tx IDs across restart.
  - tx id queryability post-restart: passed (all tested IDs queryable after restart).
  - status progression continuity: passed (submitted -> confirmed observed after restart).
  - nonce corruption signs: not observed.

### 5) RPC Failover

- Evidence: `scenario4-rpc-failover.json`
- Threshold used:
  - pass if `>=95%` success with one dead + one healthy endpoint
- Outcome: pass (submission-level)
- Notes:
  - dead-first trial: 20/20 accepted after network patch with dead endpoint first
  - valid-first trial: 20/20 accepted with valid endpoint first
  - caveat: acceptance was measured at submission API level; deeper per-tx transport trace correlation should be added for production confidence.

### 6) Replacement/Cancel APIs

- Evidence: `scenario5-replacement-cancel.json`, `scenario5b-replacement-explicit.json`
- Outcome: pass (with request-shape constraints)
- Notes:
  - speed-based replace attempt returned `400` (`Unable to calculate sufficient price bump for speed-based replacement`).
  - explicit replace with numeric fee fields succeeded (`200`) and produced replacement hash while keeping same transaction ID/nonce.
  - replace request typing matters: fee fields must be numeric JSON values for `u128` (stringified numbers are rejected).
  - cancel behavior: `DELETE .../transactions/{id}` succeeded and returned status `canceled`
  - pending-delete behavior: `DELETE .../transactions/pending` succeeded and queued cancellations

### 7) Metrics/Health

- Evidence: `scenario6-metrics-health.json`
- Outcome: pass
- Notes:
  - health/readiness endpoint quality: `/api/v1/health` and `/api/v1/ready` both working; readiness gives component breakdown
  - metrics endpoint scrapeability: `/metrics` returns 200
  - key metric names available: includes request/latency and rpc call metrics (see metric sample in result JSON)

## Implementation Requirements

- Require Redis repository mode in deployment defaults.
- Keep lifecycle mapping aligned to observed statuses: `pending/sent/submitted`, `confirmed/mined`, `failed`, `canceled`, `expired`.
- Require startup readiness to verify the relayer signer is funded on each enabled chain.
- Use explicit numeric fee fields for manual replacement.
- Do not rely on speed-only replacement for recovery.
- For production failover validation, add tx-level proof through relayer logs and eventual transaction hashes in addition to submission success rate.

## Storage Implication

- With Redis repository storage enabled, relayer restart persistence behaved as required.
- SQLite is sufficient for ClearMacro Provider app state because the app stores request/idempotency/audit data while OpenZeppelin Relayer owns durable transaction backend state in Redis.

## Follow-Ups

- Should provider API always normalize replacement payload fee fields to numeric types before forwarding to OZ Relayer?
- Should we expose only one replacement mode publicly (explicit fee bump) to avoid fragile speed-based replacement outcomes?
