# ClearMacro Provider Backend: Transaction Policy

## Goal

Define the concrete transaction submission, retry, replacement, dropped-detection, and finality rules for v1. This policy is intentionally conservative and simple. It can be made more sophisticated after production observations.

## Core Model

Transaction processing has two durable phases:

1. Submission: send a signed raw transaction with `eth_sendRawTransaction`. The RPC either rejects it immediately or accepts it and returns a transaction hash.
2. Inclusion/finality: after acceptance, track the transaction by hash until receipt plus required confirmations, dropped/replaced/expired, or terminal provider failure.

Never model this as one blocking operation in persisted state.

## Chain Policy

Each chain has policy from registry plus defaults.

Registry fields:

- `confirmations`: required confirmation count for finalization.
- `rpcs`: ordered list of named RPC endpoints, each with `name` and `url`.

Default policy:

- `confirmations`: env `DEFAULT_CONFIRMATIONS`, default `1`.
- `workerPollIntervalMs`: `1000`.
- `receiptPollIntervalMs`: `3000`.
- `rpcRequestTimeoutMs`: `10000`.
- `sendRetryCount`: `3`.
- `sendRetryBaseDelayMs`: `1000`.
- `pendingStuckAfterMs`: `120000`.
- `maxReplacementAttempts`: `5`.
- `droppedCheckMinAgeMs`: `300000`.
- `droppedUnknownChecks`: `3` full checks across all configured RPC endpoints.
- `gasLimitMultiplierBps`: `12000` (120%).
- `feeBumpBps`: `1250` (12.5%).
- `minPriorityFeeWei`: `1000000` for chains that return zero/very low priority fees.

Expose these as code constants first. Make them configurable later only if needed.

## Nonce Policy

The relayer account is exclusively owned by this application.

Rules:

- On first startup for a chain, initialize `chain_cursors.next_nonce` from `eth_getTransactionCount(relayer, "pending")`.
- Reserve nonces transactionally in Postgres by incrementing `chain_cursors.next_nonce`.
- Multiple requests may reserve different nonces and be pending at the same time.
- Never reuse a nonce if a raw signed transaction was persisted for that nonce, unless creating a replacement for the same request/attempt lineage.
- If the database has a cursor for a chain, do not reset it from RPC automatically on restart.
- If RPC pending nonce is greater than local cursor, alert and advance local cursor only through an explicit recovery path. This should not happen under the exclusive-account assumption.
- If RPC pending nonce is lower than local cursor, continue using local cursor; earlier transactions may still be pending or not visible to that RPC.

## Gas And Fee Policy

### Gas Limit

For each new attempt:

- Estimate gas with the selected RPC.
- If estimation fails with deterministic revert-like error, transition request to `preflight_failed`.
- If estimation fails due to transient RPC failure, retry another RPC if available.
- Set gas limit to `estimate * gasLimitMultiplierBps / 10000`, rounded up.

### EIP-1559 Fees

Use EIP-1559 where supported by the chain/RPC.

Initial fee:

- Use `estimateFeesPerGas`/fee history equivalent from viem.
- Ensure `maxPriorityFeePerGas >= minPriorityFeeWei` when the chain reports zero or implausibly low tip.
- Ensure `maxFeePerGas >= baseFee * 2 + maxPriorityFeePerGas` if base fee is available.

Replacement fee:

- New `maxFeePerGas` must be at least previous `maxFeePerGas * (1 + feeBumpBps / 10000)`.
- New `maxPriorityFeePerGas` must be at least previous `maxPriorityFeePerGas * (1 + feeBumpBps / 10000)`.
- Also respect current network fee estimates if they are higher.

### Legacy Gas Price

For chains/RPCs that require legacy transactions:

- Use `getGasPrice`.
- Replacement gas price must be at least previous `gasPrice * (1 + feeBumpBps / 10000)`.

### Insufficient Funds

If the relayer account lacks native token for gas:

- Do not keep retrying aggressively.
- Transition affected request to `failed` with error code `RELAYER_INSUFFICIENT_FUNDS`.
- Emit an alert-worthy metric/log.

## RPC Selection Policy

For each chain, use the ordered `rpcs` list from registry.

Rules:

- Try the first healthy RPC by default.
- On timeout/network/5xx/malformed response, try the next RPC.
- Keep lightweight in-memory health status per RPC.
- A single RPC failure must not make the request terminal if another RPC is available.
- Persist the RPC `name` used for each send/receipt event. Do not persist full RPC URLs, because they may contain API keys.

## Send Error Classification

Classify `eth_sendRawTransaction` errors into these categories.

### Accepted Equivalents

Treat as accepted/pending if the error indicates the exact same transaction is already known.

Examples:

- `already known`
- `already imported`
- provider-specific equivalent where tx hash can be derived from raw tx

Action:

- Persist tx hash.
- Set attempt/request to `pending`.

### Retryable Transient Errors

Examples:

- network timeout
- connection refused/reset
- HTTP 429/5xx
- malformed JSON-RPC response
- temporary backend unavailable

Action:

- Retry up to `sendRetryCount` across available RPCs with exponential backoff.
- If exhausted before any tx hash is accepted, transition request to `submit_failed`.

### Replaceable Fee Errors

Examples:

- `replacement transaction underpriced`
- `fee too low`
- `max fee per gas less than block base fee`
- `transaction underpriced`

Action:

- If this is first submission before tx acceptance, rebuild/sign with bumped/current fees and retry.
- If replacing an already pending attempt, create a replacement attempt with same nonce.
- Respect `maxReplacementAttempts`.

### Nonce Errors

Examples:

- `nonce too low`
- `already known` with same hash
- `nonce too high`

Action:

- `already known`: accepted equivalent.
- `nonce too low`: query transaction/receipt for known attempts with that nonce. If a prior attempt confirmed, finalize accordingly. If no known attempt exists, transition to `failed` and alert because exclusive nonce ownership invariant was violated.
- `nonce too high`: retry other RPCs. If all agree, keep request queued/pending and alert on nonce gap; do not skip or reuse nonces automatically.

### Deterministic Transaction Rejection

Examples:

- malformed raw transaction
- invalid chain id
- intrinsic gas too low after rebuild attempts
- sender has insufficient funds

Action:

- If caused by provider construction/signing bug, transition to `failed`.
- If caused by relayer balance, transition to `failed` with `RELAYER_INSUFFICIENT_FUNDS`.
- If caused by request data and preflight missed it, transition to `submit_failed` or `preflight_failed` depending on whether an RPC accepted any transaction.

## Pending Tracking Policy

Once a tx hash is accepted:

- Request state becomes `pending`.
- Poll `eth_getTransactionReceipt` every `receiptPollIntervalMs`.
- If receipt is present, persist it and track confirmation depth.
- Finalize only after `confirmations` blocks are reached.
- If receipt status is success, request state becomes `confirmed`.
- If receipt status is failure, request state becomes `reverted`.

Confirmation depth:

- If receipt block number is `B` and current head is `H`, depth is `H - B + 1`.
- If chain reorg causes the receipt to disappear before finalization, return to `pending` and continue tracking.
- After finalization, do not reverse terminal state in v1. Use conservative confirmation counts in registry for chains where this matters.

## Rebroadcast Policy

If an accepted transaction has no receipt:

- Query `eth_getTransactionByHash`.
- If known by any configured RPC, keep `pending`.
- If unknown on the current RPC but not old enough for dropped checks, rebroadcast the exact same raw tx.
- Rebroadcasting the same raw tx must not create a new attempt.
- Persist a `rebroadcasted` audit event.

## Replacement Policy

If a pending transaction has no receipt and is older than `pendingStuckAfterMs`:

- Create a replacement attempt with the same nonce and same transaction semantics.
- Bump fees according to gas policy.
- Sign and send replacement raw tx.
- Mark previous attempt `replaced` only after replacement is accepted by an RPC.
- Request remains `pending` and current tx hash changes to the replacement tx hash.
- Stop after `maxReplacementAttempts`; then rely on dropped detection or eventual receipt.

Do not create a replacement if `validBefore` is close enough that inclusion would likely happen after expiry. In that case, transition to `expired` only if no accepted transaction can still validly execute under policy.

## Dropped Detection Policy

Dropping is conservative because RPC nodes can disagree.

A pending attempt may be marked `dropped` only if:

- It is older than `droppedCheckMinAgeMs`.
- No receipt exists on any configured RPC.
- `eth_getTransactionByHash` returns unknown on all configured RPCs.
- The above full check has happened `droppedUnknownChecks` times separated by at least `receiptPollIntervalMs`.
- Replacement policy is exhausted or not applicable.

When the final active attempt is dropped and no replacement remains, request state becomes `dropped`.

## Expiry Policy

ClearMacro payloads include `validAfter` and `validBefore`.

Rules:

- If `validBefore != 0` and already elapsed before request acceptance, reject synchronously with `CLEAR_MACRO_EXPIRED`.
- If `validAfter` is in the future, keep request `queued` until it becomes valid if delayed execution is enabled; otherwise reject synchronously with `CLEAR_MACRO_NOT_YET_VALID`.
- Before signing/sending, re-check `validBefore`.
- Do not submit a new transaction or replacement after `validBefore` elapsed.
- If a transaction was already accepted before `validBefore`, continue tracking it. If it reverts due to expiry, finalize as `reverted`.

## Preflight Policy

Preflight should reduce avoidable failed transactions but must not become an overcomplicated simulator.

For v1:

- Use `eth_call`/viem simulation for the exact forwarder call when practical.
- Run preflight before nonce reservation if possible.
- If preflight returns a deterministic revert, transition to `preflight_failed`.
- If preflight fails due to RPC/network problems, do not terminally fail immediately; retry another RPC or continue to queued if policy allows.
- Preflight success is not a guarantee. The real transaction may still revert.

## Startup Recovery Policy

On startup:

- Load all non-terminal requests.
- Load active attempts and nonce reservations.
- For `accepted` or `queued` requests without attempts, enqueue them.
- For `pending` requests with active attempts, resume receipt polling and dropped/replacement checks.
- For attempts with persisted raw tx but no accepted tx hash, retry submission unless request expired.
- Do not allocate new nonces until `chain_cursors` have been loaded and checked.

## Library Guidance

Use viem for RPC, ABI encoding, signing utilities, fee estimation, transaction serialization, and receipt polling primitives.

Do not use a library abstraction that hides submission and confirmation as one opaque blocking operation in the durable transaction manager. If a helper like `waitForTransactionReceipt` is used internally, the code must still persist accepted tx hash, receipt observation, confirmation depth, and terminal state separately.
