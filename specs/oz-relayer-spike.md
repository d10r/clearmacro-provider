# Spike: Evaluate OpenZeppelin Relayer As Transaction Backend

## Goal

Validate that OpenZeppelin Relayer satisfies the ClearMacro Provider transaction-backend requirements before implementation begins.

This is a focused spike. Do not implement the ClearMacro Provider API. Do not refactor the main specs yet. The output should be evidence: scripts, logs, observed API responses, and a short recommendation.

## Questions To Answer

The spike must answer these questions:

- Can OpenZeppelin Relayer safely support multiple in-flight transactions from the same EVM relayer account without waiting for confirmations?
- Does it allocate nonces correctly under burst submission?
- Does it expose enough transaction status information to map into our public lifecycle states?
- Does it distinguish success, revert, pending, failed, replaced, canceled, or equivalent terminal states clearly enough?
- Does it recover pending transaction state after relayer restart?
- Can it be configured file-first for Docker Compose production deployment?
- Can it use multiple RPC endpoints with failover behavior suitable for our needs?
- Are its replacement/cancel APIs sufficient if we need manual or automatic intervention?
- Are its metrics/health endpoints suitable for existing Prometheus/Grafana monitoring?

## Non-Goals

- Do not build the final ClearMacro Provider API.
- Do not implement ClearMacro validation.
- Do not integrate Superfluid contracts.
- Do not build production deployment for the final app.
- Do not decide the final database choice beyond recording implications.
- Do not modify implementation specs while running the spike; record evidence and update the architecture only after results are reviewed.

## Location

Create the spike under:

```text
spikes/oz-relayer/
```

Suggested structure:

```text
spikes/oz-relayer/
  README.md
  compose.yaml
  config/
    config.json
    networks.json
  scripts/
    wait-ready.ts
    submit-burst.ts
    poll-transactions.ts
    restart-and-recover.ts
    submit-revert.ts
    test-rpc-failover.ts
  results/
    .gitkeep
```

Keep this self-contained and clearly marked as experimental.

## Runtime Components

Use Docker Compose for runtime services:

- OpenZeppelin Relayer.
- Redis, because OZ Relayer uses Redis for storage/queueing in persistent mode.
- Anvil local EVM chain.

Do not bundle Prometheus/Grafana. The spike may call the metrics endpoint directly.

The host may run TypeScript scripts with `pnpm`/`tsx`.

## Dependencies

Use existing project dependencies where possible. If a dependency is needed only for the spike, prefer using existing `viem` and native `fetch` before adding anything.

The spike scripts may use:

- `viem` for local account utilities and transaction calldata.
- native Node `fetch` for OpenZeppelin Relayer API calls.
- `tsx` for running TypeScript scripts.

## OpenZeppelin Relayer Setup

Use the current stable OpenZeppelin Relayer Docker image if available. If no stable image is available, build from the upstream repository in the spike instructions and document that friction.

Configure one EVM relayer for the local Anvil network.

Requirements:

- One configured relayer account controlled by OZ Relayer.
- Anvil must fund the relayer account.
- API authentication should be enabled if required by OZ Relayer, with a test API key stored in local spike config/env only.
- Use file-based configuration, not runtime API-based configuration, unless file-based setup cannot support the scenario.
- Configure custom RPC endpoints for the Anvil chain.

Record exact setup steps in `spikes/oz-relayer/README.md`.

## Test Contracts / Transactions

The spike does not need ClearMacro contracts. Use simple EVM transactions that still exercise transaction semantics.

Minimum transaction types:

- Native ETH transfer from relayer to a test address.
- Contract call that succeeds.
- Contract call that reverts.

If adding a small Solidity contract is easier, use a minimal contract deployed to Anvil with functions:

```solidity
function succeed(uint256 value) external;
function fail() external pure;
```

The implementation may deploy it using Anvil pre-funded accounts and `viem`.

## Scenario 1: Burst Submission

Purpose: verify nonce handling and concurrent in-flight transaction support.

Steps:

1. Start Compose stack.
2. Wait for OZ Relayer readiness.
3. Submit 20 transactions as quickly as possible through the OZ Relayer transaction API without waiting for confirmations.
4. Record every returned OZ transaction id, tx hash if available, nonce if available, and initial status.
5. Poll all transactions until terminal.
6. Verify all transactions have distinct nonces and all terminal statuses are successful.

Success criteria:

- All submissions are accepted by OZ Relayer or rejected for a documented, understandable configuration reason.
- If accepted, nonces are unique and sequential or otherwise valid.
- Confirmation does not have to complete before later submissions are accepted.
- Status API exposes enough data to correlate transaction id, tx hash, nonce, and final status.

## Scenario 2: Revert Handling

Purpose: verify how OZ Relayer represents onchain reverts.

Steps:

1. Submit a transaction expected to revert.
2. Poll until terminal.
3. Record status, status reason, receipt fields, and any error payload.

Success criteria:

- Revert is visible as a distinct failed/reverted status or with enough receipt/status data for us to map it to `reverted`.
- Transaction hash and receipt data are retrievable.

## Scenario 3: Restart Recovery

Purpose: verify pending transaction state survives relayer restart.

Steps:

1. Submit multiple transactions.
2. Restart the OZ Relayer container while transactions are pending, or as soon after submission as practical.
3. After restart, query each transaction by OZ transaction id.
4. Poll until terminal.

Success criteria:

- Previously accepted transaction ids remain queryable.
- OZ Relayer continues or resumes status tracking.
- No nonce corruption is observed.

If Anvil mines too quickly to make pending restart practical, document that limitation and run the restart immediately after burst submission. Optionally configure Anvil block time to slow mining.

## Scenario 4: RPC Failover

Purpose: verify multiple RPC endpoint behavior.

Steps:

1. Configure two RPC endpoints for the Anvil network: one invalid/dead endpoint and one valid Anvil endpoint.
2. Submit a transaction.
3. Record whether OZ Relayer fails over to the valid endpoint.
4. Repeat with the valid endpoint first and dead endpoint second.

Success criteria:

- A single dead RPC endpoint does not make submission terminal if another endpoint works.
- Logs or status expose enough information to diagnose RPC failure/failover.

If OZ Relayer requires weighted/custom RPC configuration rather than simple named endpoints, use its native model and document how it maps to our desired registry format.

## Scenario 5: Replacement And Cancel APIs

Purpose: understand manual intervention capabilities.

Steps:

1. Create or identify a pending transaction.
2. Call OZ Relayer's replace endpoint if available.
3. Call OZ Relayer's cancel endpoint if available.
4. Record request/response schemas and resulting transaction statuses.

Success criteria:

- Replacement/cancel behavior is documented well enough to decide whether the ClearMacro Provider needs to expose or internally use these operations.

If local Anvil makes this hard because transactions mine immediately, document the limitation and inspect API behavior with a best-effort pending transaction using delayed mining.

## Scenario 6: Metrics And Health

Purpose: verify operational observability.

Steps:

1. Query OZ Relayer health/readiness endpoints.
2. Query metrics endpoint.
3. Record relevant metric names for transaction submission, status checking, RPC/provider failures, queue depth, and worker health.

Success criteria:

- There is a scrapeable metrics endpoint.
- Metrics are sufficient to monitor the transaction backend separately from ClearMacro Provider metrics.

## Output Artifacts

The implementer must produce:

- `spikes/oz-relayer/README.md` with exact commands to run the spike.
- Compose/config files needed to run the spike.
- TypeScript scripts for the scenarios above.
- Result files under `spikes/oz-relayer/results/` with representative JSON responses/log snippets.
- A final `spikes/oz-relayer/results/conclusion.md` answering:
  - Is OZ Relayer viable as the transaction backend?
  - Which requirements does it satisfy?
  - Which requirements are unclear or not satisfied?
  - What changes would be needed in the main specs if we adopt it?
  - Does this imply SQLite is sufficient for ClearMacro Provider state?

## Decision Criteria

Recommend adopting OpenZeppelin Relayer if all are true:

- Burst submission works without nonce corruption.
- Transaction status can be reliably mapped to our lifecycle: `pending`, `confirmed`, `reverted`, `submit_failed`, `dropped/failed`.
- Restart recovery works with Redis persistence.
- RPC failover is adequate or can be configured adequately.
- Operational complexity is acceptable with Docker Compose.
- AGPL licensing is acceptable for this project.

Do not proceed with OpenZeppelin Relayer if any are true:

- OZ Relayer cannot support multiple in-flight transactions for one EVM relayer account.
- Transaction status is too opaque to build a reliable ClearMacro lifecycle.
- Restart recovery is inadequate.
- RPC failover is inadequate and cannot be configured safely.
- Replacement/cancel semantics conflict with ClearMacro validity windows.
- Operational or licensing constraints are unacceptable.

## Important Notes

- Treat this as a spike, not production code.
- Prefer direct HTTP calls to OZ Relayer API over adding its SDK unless the API is cumbersome.
- Do not store real secrets in the repository.
- Do not use production networks in this spike.
- Keep results concise but concrete. Include enough raw API responses to support the recommendation.
