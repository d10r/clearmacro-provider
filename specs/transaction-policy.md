# ClearMacro Provider Backend: Relayer Policy

## Goal

Define how the ClearMacro Provider app uses OpenZeppelin Relayer for transaction execution and how relayer status is projected into ClearMacro request lifecycle state.

The app does not implement nonce allocation, transaction signing, raw transaction rebroadcast, gas replacement loops, or dropped-transaction heuristics. Those responsibilities belong to OpenZeppelin Relayer.

## Core Model

Transaction processing has three persisted app phases:

1. Acceptance: the app validates and stores a ClearMacro request.
2. Relayer submission: the app submits transaction intent to OpenZeppelin Relayer and stores the returned relayer transaction ID.
3. Reconciliation: the same worker polls OpenZeppelin Relayer status and projects it into ClearMacro lifecycle state.

Never model relay as one blocking operation. `POST /v1/relay` returns after acceptance and persistence, not after transaction submission or confirmation.

## Chain Policy

Each chain has policy from the registry plus defaults.

Registry fields:

- `confirmations`: required confirmation count for finalization. This should match or be no stricter than the OpenZeppelin Relayer network config for the same chain.
- `rpcs`: named app RPC endpoints for validation and preflight.
- `ozRelayerId`: OpenZeppelin Relayer ID used for execution on that chain.

Default app policy:

- `confirmations`: env `DEFAULT_CONFIRMATIONS`, default `1`.
- `relayerWorkerPollIntervalMs`: env `RELAYER_WORKER_POLL_INTERVAL_MS`, default `2000`.
- `relayerRequestTimeoutMs`: env `RELAYER_REQUEST_TIMEOUT_MS`, default `10000`.
- `submitRetryCount`: `3`.
- `submitRetryBaseDelayMs`: `1000`.
- `gasLimitMultiplierBps`: `12000` for optional app-side gas limit override. Prefer OpenZeppelin Relayer estimation unless a concrete issue requires an override.

Expose these as code constants first. Make them configurable later only if needed.

## OpenZeppelin Relayer Requirements

- Use OpenZeppelin Relayer with Redis repository storage.
- Set `REPOSITORY_STORAGE_TYPE=redis`.
- Set `RESET_STORAGE_ON_START=false`.
- Keep `STORAGE_ENCRYPTION_KEY` stable across restarts.
- Enable metrics on the relayer.
- Configure relayers and networks file-first.
- Configure at least one healthy RPC per enabled chain in OpenZeppelin Relayer network config.
- Keep the relayer signer exclusively owned by OpenZeppelin Relayer for this application.
- Ensure the relayer signer has native gas token on each enabled chain before accepting work.

## Nonce Policy

The ClearMacro Provider app never allocates or reserves EVM nonces.

Rules:

- Do not store local nonce cursors.
- Do not call `eth_getTransactionCount` for execution nonce decisions.
- Do not sign transactions in the app.
- Do not submit transactions from the relayer account outside OpenZeppelin Relayer.
- Store nonce values only as observed relayer status fields for audit/debugging.

## Transaction Construction Policy

For `clearMacroV1`, the app submits this transaction intent to OpenZeppelin Relayer:

- `relayerId`: `chains[].ozRelayerId` from registry.
- `to`: configured `ClearMacroForwarderV1` address.
- `value`: `msgValue` from request, default `0`.
- `data`: ABI encoding of `ClearMacroForwarderV1.runMacro(macro, params, signer, signature)`.

For `permit2ClearMacroV1`, keep schemas but reject until implemented.

## Preflight Policy

Preflight should reduce avoidable failed transactions but must not become an overcomplicated simulator.

For v1:

- Use app registry RPCs and viem simulation for the exact forwarder call when practical.
- Run preflight before OpenZeppelin Relayer submission if it can be done without materially increasing latency.
- If preflight returns a deterministic revert, transition to `preflight_failed`.
- If preflight fails due to RPC/network problems, retry another app RPC if available. If no app RPC is healthy, return `503 CHAIN_UNAVAILABLE` before accepting the request.
- Preflight success is not a guarantee. The real transaction may still revert and should then become `reverted` based on relayer status.

## App RPC Selection Policy

The app uses registry `rpcs` only for validation and preflight. OpenZeppelin Relayer uses its own configured RPCs for execution.

Rules:

- Try the first healthy app RPC by default.
- On timeout/network/5xx/malformed response, try the next app RPC.
- Keep lightweight in-memory health status per app RPC.
- A single app RPC failure must not reject the request if another app RPC is available.
- Use RPC `name` in logs, metrics, and audit events. Do not persist full RPC URLs because they may contain API keys.

## Relayer Submission Policy

When a request is accepted:

- Persist it as `accepted` and return `202` from the API.
- The relayer worker claims a batch of `accepted`/`queued` non-terminal requests without `oz_transaction_id`.
- The worker transitions claimed requests to `queued` and submits each transaction intent to OpenZeppelin Relayer.
- Persist the returned OpenZeppelin transaction ID immediately.
- Transition the request to `pending` once OpenZeppelin Relayer accepts the transaction intent.
- Append a `relayer_submit_accepted` audit event with relayer id and transaction id.

Submission HTTP failures:

- Retry transient network/5xx/429 errors up to `submitRetryCount`.
- Treat 4xx validation errors from OpenZeppelin Relayer as `submit_failed`, unless the error indicates relayer unavailability and retry is appropriate.
- If OpenZeppelin Relayer is unreachable after retries, transition to `submit_failed` and alert.
- Do not attempt local raw transaction fallback.

The v1 worker may use simple SQLite transactions for claiming work. Do not add a separate queue service.

## Lifecycle Projection Policy

The relayer worker polls OpenZeppelin Relayer by transaction ID for non-terminal requests.

Mapping:

| OpenZeppelin Relayer status | ClearMacro request state | Notes |
| --- | --- | --- |
| `pending` | `pending` | Intent accepted but not yet sent. |
| `sent` | `pending` | Transaction in progress. |
| `submitted` | `pending` | Hash/nonce may be available. |
| `mined` | `confirmed` | If exposed before `confirmed`, treat as successful terminal for v1 unless more confirmations are required externally. |
| `confirmed` | `confirmed` | Successful terminal state. |
| `failed` with revert-like reason | `reverted` | Match reasons containing `revert`, `reverted`, `receipt status: failed`, or equivalent. |
| `failed` without revert signal | `failed` | Terminal infrastructure or submission failure. |
| `canceled` | `canceled` | Operator or relayer cancellation. |
| `expired` | `expired` | Relayer or app expiry. |

On each poll:

- Upsert `relayer_transactions` with the latest relayer status and raw JSON snapshot.
- Update `relay_requests.current_tx_hash` when relayer hash changes.
- Append an audit event only when meaningful fields changed or the request reaches a terminal state.

## Replacement Policy

Manual replacement is an operator workflow, not part of normal public request handling.

Rules:

- Only attempt replacement after the OpenZeppelin transaction is `submitted` and exposes nonce/hash/fee fields.
- Prefer explicit fee replacement over speed-only replacement.
- For legacy fee replacement, set a numeric JSON `gas_price` greater than the observed previous gas price by at least 10%.
- For EIP-1559 replacement, set numeric JSON `max_fee_per_gas` and `max_priority_fee_per_gas` greater than observed previous values by at least 10% and high enough for current network conditions.
- If replacement succeeds, OpenZeppelin Relayer may keep the same transaction ID and update the hash. The app must preserve the new hash and append an audit event.
- If replacement fails with a price-bump calculation error, retry with explicit fee fields or cancel if operator policy allows.

Do not submit an app-created replacement after `validBefore` has elapsed. If a relayer transaction was already accepted before expiry, continue reconciling it.

## Cancel Policy

Manual cancel is an operator workflow.

Rules:

- Cancel through OpenZeppelin Relayer only.
- If cancel succeeds, project the request to `canceled`. If later evidence contradicts a terminal state, append an audit event and alert; do not automatically rewrite history in v1.
- App APIs should not expose cancel publicly in v1 unless an explicit authenticated operator API is added.

## Expiry Policy

ClearMacro payloads include `validAfter` and `validBefore`.

Rules:

- If `validBefore != 0` and already elapsed before request acceptance, reject synchronously with `CLEAR_MACRO_EXPIRED`.
- If `validAfter` is in the future, keep request `queued` until it becomes valid if delayed execution is enabled; otherwise reject synchronously with `CLEAR_MACRO_NOT_YET_VALID`.
- Before submitting to OpenZeppelin Relayer, re-check `validBefore`.
- Do not submit a new relayer transaction after `validBefore` elapsed.
- If a transaction was already accepted by OpenZeppelin Relayer before `validBefore`, continue tracking it. If it reverts due to expiry, finalize as `reverted`.

## Startup Recovery Policy

On app startup:

- Open SQLite and run migrations if enabled.
- Load non-terminal requests.
- For requests without an OpenZeppelin transaction ID and still valid, let the relayer worker submit them.
- For requests with an OpenZeppelin transaction ID, resume polling.
- Do not attempt to reconstruct OpenZeppelin Relayer internal state in the app.

On OpenZeppelin Relayer restart:

- Redis repository storage must preserve transaction IDs and status.
- App reconciliation should continue polling the same transaction IDs.
- If a known transaction ID becomes permanently unqueryable, mark affected requests `failed` with `RELAYER_TRANSACTION_NOT_FOUND` and alert.

## Library Guidance

- Use viem for ABI encoding, signature utilities, app RPC calls, and simulation.
- Use native `fetch` for OpenZeppelin Relayer HTTP calls unless a typed SDK becomes clearly beneficial.
- Use `node:sqlite` for SQLite access; keep SQL explicit and small.
- Do not add a queue system unless SQLite + the relayer worker loop becomes insufficient under measured load.
