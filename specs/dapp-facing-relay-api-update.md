# Dapp-Facing Relay API Update Spec

> **Status:** Superseded for the shipped public API and registry by [`simplified-dapp-facing-relay-api.md`](./simplified-dapp-facing-relay-api.md). This file is kept for historical design discussion (e.g. earlier idempotency-key model and `accepted` / `included` states).

## Goal

Update `clearmacro-provider` so a dapp can migrate from connected-wallet transaction broadcasting to ClearMacro relaying with minimal transaction-state complexity.

The provider may remain request-based internally, because relayed execution needs a stable identifier before an EVM transaction hash exists. However, the public API must present a small transaction-like lifecycle instead of exposing OpenZeppelin Relayer details, worker queue details, or low-level internal states.

This is a breaking v1 redesign. Do not keep compatibility with the current `/v1/relay` request/response shapes, current public state names, or current `params` naming.

## Design Principles

- The stable provider execution ID is primary; EVM transaction hash is secondary and may appear later or change due to replacement/repricing.
- The public state machine should resemble a normal dapp transaction flow: accepted by service, pending submission, submitted with hash, included, succeeded/reverted.
- Internal infrastructure states must not leak into the dapp API unless the dapp needs to change UI behavior.
- The initial API call must never wait unboundedly for a tx hash or receipt.
- Synchronous request validation failures should behave like wallet/RPC pre-hash failures: no execution object is created unless the provider has accepted responsibility for retry/reconciliation.
- Once an execution object is returned, the provider is responsible for making progress to a terminal state or exposing a clear terminal failure.
- The API should be safe to retry using idempotency keys. `clientRequestId` is for dapp correlation/restoration, not exactly-once semantics.
- The public API should avoid OpenZeppelin-specific names. OZ IDs and raw status snapshots are internal diagnostics.

## Prior Art Summary

OpenZeppelin Defender Relayer, Gelato Relay, Biconomy MEE, and ERC-4337 bundlers all use a stable relayer/bundler operation ID because an EVM transaction hash is not guaranteed immediately and can change during replacement/repricing.

Relevant patterns to adopt:

- Return a stable execution/task/request ID immediately after acceptance.
- Expose tx hash only when available.
- Poll by stable ID.
- Treat tx hash changes as normal, not as a new user action.
- Provide receipt/block data once included.

Relevant patterns to avoid:

- Making the dapp use vendor-specific relayer transaction IDs.
- Treating `hash` as the only durable identifier.
- Blocking the main submit request until final onchain inclusion.

## Public Concepts

### Relay Execution

The public resource is a relay execution. It represents one accepted signed ClearMacro execution attempt from the dapp/user perspective.

Use `id` as the stable provider execution ID in all public responses.

Do not expose `relay_requests`, `ozRelayerId`, `ozTransactionId`, `relayerTransactionId`, or raw OZ status fields in public dapp endpoints.

### Transaction Hash

`transaction.hash` is the currently preferred EVM transaction hash, if known.

`transaction.hashes` is the ordered history of observed current-hash changes for this execution. It exists because relayer replacement/repricing can change the transaction hash while preserving the same provider execution ID. Repeated hashes are allowed if the relayer later reports a previously seen hash as current again.

The dapp should use the provider execution ID as the canonical transaction-tracking key for relayed executions. The EVM transaction hash is display/linking metadata and receipt correlation, not the durable dapp-side ID.

### Receipt

`receipt` is present after an onchain receipt is known. It should use JSON-friendly strings for large integer values.

Receipt fields should be provider-normalized, not raw RPC response blobs.

## Public State Machine

Canonical public states:


| State       | Terminal | Meaning                                                                                                                                                |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accepted`  | no       | Provider accepted the signed payload and created a durable execution object. Submission may not have started yet. This state should normally be brief. |
| `pending`   | no       | Provider/relayer is trying to submit the transaction, but no EVM transaction hash is known yet.                                                        |
| `submitted` | no       | At least one EVM transaction hash is known. The transaction is waiting for inclusion or confirmation.                                                  |
| `included`  | no       | A successful receipt or relayer mined status is known, but required confirmation policy has not finalized it yet.                                      |
| `succeeded` | yes      | Execution succeeded and met provider finality policy.                                                                                                  |
| `reverted`  | yes      | An EVM transaction was included but execution reverted or relayer reported a receipt failure/revert.                                                   |
| `rejected`  | yes      | Provider rejected the execution after creating an execution object because deterministic validation/preflight failed before network submission.        |
| `failed`    | yes      | Provider/relayer infrastructure failed before a reliable onchain terminal outcome was known.                                                           |
| `expired`   | yes      | The ClearMacro validity window elapsed before successful submission/execution.                                                                         |
| `canceled`  | yes      | Execution was canceled before a successful onchain terminal outcome was known.                                                                         |


Allowed public transitions:


| From        | To                                                                                |
| ----------- | --------------------------------------------------------------------------------- |
| none        | `accepted`                                                                        |
| `accepted`  | `pending`, `rejected`, `expired`, `failed`                                        |
| `pending`   | `submitted`, `rejected`, `expired`, `failed`, `canceled`                          |
| `submitted` | `submitted`, `included`, `succeeded`, `reverted`, `expired`, `failed`, `canceled` |
| `included`  | `succeeded`, `reverted`, `failed`                                                 |


Notes:

- `submitted -> submitted` is allowed only for metadata updates such as hash replacement, gas fields, or polling timestamps. It is not a new state transition audit event unless meaningful fields changed.
- Do not transition out of terminal states automatically. If later evidence contradicts a terminal state, append an internal audit event and alert.
- If the relayer reports `confirmed` directly, transition to `succeeded`; do not force an intermediate `included` state.
- If the relayer reports `mined` and confirmation policy is satisfied by the relayer/network config, transition to `succeeded`; otherwise transition to `included`.

## Endpoint Changes

### Create Relay Execution

Replace `POST /v1/relay` with:

```text
POST /v1/relay-executions
```

Request body:

```ts
type CreateRelayExecutionRequest = {
  kind: "clearMacroV1";
  chainId: number;
  forwarderAddress: `0x${string}`;
  macroAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  payload: `0x${string}`;
  signature: `0x${string}`;
  value?: string;
  clientRequestId?: string;
  metadata?: Record<string, string>;
};
```

Field naming changes from current API:


| Current                    | New                | Reason                                                             |
| -------------------------- | ------------------ | ------------------------------------------------------------------ |
| `macro`                    | `macroAddress`     | Address fields should be explicit.                                 |
| `forwarder`                | `forwarderAddress` | Address fields should be explicit.                                 |
| `signer`                   | `signerAddress`    | Address fields should be explicit.                                 |
| `params`                   | `payload`          | The dapp constructs a ClearMacro payload; `params` is too generic. |
| `msgValue`                 | `value`            | Matches transaction API vocabulary.                                |
| `requestId` response field | `id`               | Public resource ID should be idiomatic and stable.                 |
| `status` response field    | `state`            | These are lifecycle states, not HTTP status.                       |


Headers:

- `Idempotency-Key`: optional but recommended. Same client + same key + same canonical request body returns the same execution.
- `Authorization: Bearer ...`: required only when API auth is enabled.

Idempotency canonicalization:

- Normalize address fields to lowercase.
- Default missing `value` to `"0"` before hashing.
- Sort object keys recursively, including `metadata` keys.
- Hash the normalized request body, not the raw JSON byte sequence, so harmless key-order and address-case differences do not create false conflicts.

Response codes:


| Code  | Meaning                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `202` | Newly created execution accepted. The returned execution may already be terminal if bounded post-persistence processing produced a deterministic terminal state. |
| `200` | Idempotency replay for an existing execution.                                                                                                                    |
| `400` | Malformed request or unsupported shape.                                                                                                                          |
| `401` | Missing/invalid auth when auth is enabled.                                                                                                                       |
| `403` | Chain/macro/provider/client policy rejects before execution creation.                                                                                            |
| `409` | Idempotency key conflict or semantic duplicate conflict.                                                                                                         |
| `422` | Signature invalid, payload invalid, expired/not-yet-valid payload, or deterministic user/action error before execution creation.                                 |
| `503` | Provider/chain/relayer readiness failure before execution creation.                                                                                              |


Successful response body is the relay execution resource described below.

Creation behavior:

1. Validate JSON schema.
2. Authenticate client if enabled.
3. Canonicalize and hash the request body for idempotency.
4. Decode ClearMacro payload.
5. Validate macro/provider/chain/client policy.
6. Validate validity window. Reject already expired payloads synchronously.
7. Read forwarder digest and validate signature.
8. Check chain readiness.
9. Persist execution as `accepted`.
10. Attempt one bounded in-process progress step before responding:
  - Run preflight if configured.
    - Submit transaction intent to OpenZeppelin Relayer if preflight passes.
    - Persist relayer transaction ID and any returned tx hash.
    - Project public state to `pending` or `submitted`.
11. Return the current execution resource.

Bounded in-process progress step:

- This step improves dapp ergonomics by often returning `submitted` with a tx hash in the initial response.
- It must honor `RELAYER_REQUEST_TIMEOUT_MS` and never wait for inclusion/receipt.
- If this step hits a transient relayer/RPC timeout after persistence, keep the execution non-terminal (`accepted` or `pending`) and let the worker retry. Return `202` with the execution resource.
- If this step hits a deterministic preflight failure after persistence, transition to `rejected` and return `202` with the newly created execution resource.

Do not wait for an EVM tx hash by default. If the relayer returns an intent/no-hash response, return `pending`.

### Get Relay Execution

Replace `GET /v1/requests/:id` with:

```text
GET /v1/relay-executions/:id
```

Query parameters:


| Parameter | Values   | Meaning                          |
| --------- | -------- | -------------------------------- |
| `include` | `events` | Include public lifecycle events. |


Response body is the relay execution resource.

### Optional Wait Convenience

Add only if dapp integration needs it after the async API is implemented:

```text
GET /v1/relay-executions/:id/wait?until=submitted&timeoutMs=10000
```

Supported `until` values:

- `submitted`
- `included`
- `succeeded`
- `terminal`

Rules:

- Maximum `timeoutMs`: `30000`.
- Return the current execution resource when the target state is reached, a terminal state is reached, or timeout elapses.
- Timeout is not an error. It means the caller should continue polling.
- Do not add this endpoint until the base polling endpoint is stable.

Do not add a synchronous `POST` variant for v1. A sync submit endpoint tends to blur acceptance, submission, and execution finality. If later needed, implement it as a thin wrapper around create + wait with explicit timeout semantics.

## Public Resource Shape

All successful create/get/wait responses return:

```ts
type RelayExecution = {
  id: string;
  state: RelayExecutionState;
  terminal: boolean;
  kind: "clearMacroV1";
  chainId: number;
  clientRequestId?: string;
  metadata: Record<string, string>;
  forwarderAddress: `0x${string}`;
  macroAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  provider: string;
  nonce: string;
  validity: {
    validAfter: string;
    validBefore: string;
  };
  value: string;
  transaction: {
    hash?: `0x${string}`;
    hashes: `0x${string}`[];
    from?: `0x${string}`;
    to: `0x${string}`;
    nonce?: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    submittedAt?: string;
    includedAt?: string;
    confirmedAt?: string;
  };
  receipt?: {
    transactionHash: `0x${string}`;
    blockNumber: string;
    blockHash?: `0x${string}`;
    status: "success" | "reverted";
    gasUsed?: string;
  };
  error?: {
    code: string;
    message: string;
    category: "user" | "provider" | "chain" | "relayer" | "unknown";
    retryable: boolean;
  };
  timestamps: {
    createdAt: string;
    updatedAt: string;
    terminalAt?: string;
  };
  links: {
    self: string;
  };
};
```

Rules:

- `transaction.to` is always the ClearMacro forwarder address.
- `transaction.hashes` is empty until the first hash is observed.
- `transaction.hash` is the latest observed current hash and must equal the last item in `transaction.hashes` when present.
- `transaction.hashes` is a current-hash change history, not a unique set. It may contain repeated hashes.
- `receipt.transactionHash` must be one of `transaction.hashes`.
- `receipt.status` controls terminal onchain success/revert classification when receipt data is available.
- `error` is present only for terminal non-success states or non-terminal degraded diagnostics that the dapp can show. Prefer keeping non-terminal transient infrastructure errors in events/internal logs unless they affect user action.
- `metadata` is echoed because it is dapp-provided correlation/restoration data. Keep the existing metadata key/value count and length limits, and document that dapps must not put secrets in metadata.

## Error Body Shape

Replace the current error response with:

```ts
type ErrorBody = {
  error: {
    code: string;
    message: string;
    category: "user" | "provider" | "chain" | "relayer" | "auth" | "validation" | "unknown";
    retryable: boolean;
    executionId: string | null;
    details: Record<string, unknown>;
  };
};
```

Error code guidance:


| Code                          | HTTP | Category     | Retryable | Notes                                                                                                                  |
| ----------------------------- | ---- | ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`            | 400  | `validation` | false     | JSON/body/primitive validation.                                                                                        |
| `UNAUTHORIZED`                | 401  | `auth`       | false     | Missing/invalid bearer token.                                                                                          |
| `CHAIN_NOT_ALLOWED`           | 403  | `validation` | false     | Policy rejection.                                                                                                      |
| `MACRO_NOT_ALLOWED`           | 403  | `validation` | false     | Policy rejection.                                                                                                      |
| `PROVIDER_NOT_ALLOWED`        | 403  | `validation` | false     | Policy rejection.                                                                                                      |
| `IDEMPOTENCY_CONFLICT`        | 409  | `validation` | false     | Same key, different body.                                                                                              |
| `DUPLICATE_EXECUTION`         | 409  | `validation` | false     | Same semantic chain/forwarder/macro/signer/nonce. Include existing execution ID only when safe for the current client. |
| `INVALID_CLEAR_MACRO_PAYLOAD` | 422  | `user`       | false     | Payload cannot decode or macro mismatch.                                                                               |
| `CLEAR_MACRO_EXPIRED`         | 422  | `user`       | false     | Expired before acceptance.                                                                                             |
| `CLEAR_MACRO_NOT_YET_VALID`   | 422  | `user`       | true      | Retry after validAfter, unless delayed execution is later enabled.                                                     |
| `SIGNATURE_INVALID`           | 422  | `user`       | false     | Signature does not authorize digest.                                                                                   |
| `PROVIDER_NOT_READY`          | 503  | `provider`   | true      | Chain/provider readiness failed.                                                                                       |
| `RELAYER_UNAVAILABLE`         | 503  | `relayer`    | true      | OpenZeppelin Relayer not ready/reachable before acceptance.                                                            |
| `CHAIN_UNAVAILABLE`           | 503  | `chain`      | true      | App RPCs unavailable before acceptance.                                                                                |


For errors after an execution is created, store normalized `error` on the execution and transition state. Do not rely on HTTP errors for post-acceptance lifecycle failures.

For HTTP errors before a new execution is created, `executionId` identifies the execution directly associated with the error only when it is safe to reveal one. Do not also duplicate the same ID in `details.existingExecutionId`.

Identity rules:

- For idempotency replay, return the existing execution resource with `200`; do not return an error.
- For `IDEMPOTENCY_CONFLICT`, set `executionId` to the existing execution ID for the current client and keep `details` for conflict metadata, not identity.
- For `DUPLICATE_EXECUTION` owned by the same authenticated client, set `executionId` to the existing execution ID.
- For `DUPLICATE_EXECUTION` owned by another client, or when API auth is disabled and ownership is ambiguous, set `executionId` to `null` and do not reveal the existing execution ID anywhere in the body.
- For all other pre-creation HTTP errors, set `executionId` to `null`.

Semantic duplicate policy:

- Semantic duplicate detection is global across clients by design. A ClearMacro payload with the same chain, forwarder, macro, signer, and nonce represents the same signed authorization and should not be relayed twice by different tenants.
- If the duplicate belongs to the same authenticated client, the API may set `error.executionId` to the existing execution ID.
- If the duplicate belongs to another client or the API is unauthenticated and ownership is ambiguous, return `409 DUPLICATE_EXECUTION` without revealing the existing execution ID.
- Dapps that want deterministic retry behavior must use `Idempotency-Key`; semantic duplicate detection is a replay-safety guard, not a cross-client lookup feature.

## Internal Persistence Changes

Because this is pre-production and no backward compatibility is required, update the initial migration and repository types directly instead of adding compatibility migrations.

### Rename Public-Facing Columns Where Practical

The SQLite schema can keep internal names where useful, but code should expose public names via mappers. Prefer these DB changes for clarity:


| Current column      | New column                         |
| ------------------- | ---------------------------------- |
| `state`             | `state` with new public-state enum |
| `params`            | `payload`                          |
| `msg_value`         | `value`                            |
| `current_tx_hash`   | `current_transaction_hash`         |
| `clear_macro_nonce` | `nonce`                            |


Keep internal columns:

- `oz_relayer_id`
- `oz_transaction_id`
- `raw_json` in `relayer_transactions`

These are internal and must not appear in public responses.

### Relay Executions Table

Replace `relay_requests` conceptually with `relay_executions`. It is acceptable to keep the physical table named `relay_requests` only if the code clearly maps it to `RelayExecution`; however, since there is no compatibility requirement, prefer renaming the table.

Required columns:

- `id text primary key`
- `client_id text not null`
- `client_request_id text null`
- `idempotency_key text null`
- `request_body_hash text not null`
- `kind text not null`
- `state text not null`
- `terminal integer not null default 0`
- `chain_id integer not null`
- `oz_relayer_id text not null`
- `oz_transaction_id text null`
- `forwarder_address text not null`
- `macro_address text not null`
- `signer_address text not null`
- `provider text not null`
- `nonce text not null`
- `valid_after text not null`
- `valid_before text not null`
- `value text not null default '0'`
- `payload text not null`
- `signature text not null`
- `permit2_json text null`
- `metadata_json text not null default '{}'`
- `current_transaction_hash text null`
- `transaction_hashes_json text not null default '[]'`
- `receipt_json text null`
- `required_confirmations integer null`
- `last_error_json text null`
- `created_at text not null`
- `updated_at text not null`
- `terminal_at text null`

Indexes/constraints:

- Unique `(client_id, idempotency_key)` where `idempotency_key is not null`.
- Unique semantic duplicate index on `(chain_id, forwarder_address, macro_address, signer_address, nonce)`.
- Index `(state, chain_id, created_at)`.
- Index `(chain_id, current_transaction_hash)` where `current_transaction_hash is not null`.
- Index `(oz_relayer_id, oz_transaction_id)` where `oz_transaction_id is not null`.
- Optional index `(client_id, client_request_id)` where `client_request_id is not null`, non-unique unless product wants client IDs to be idempotent.

The semantic duplicate index intentionally does not include `client_id`. This prevents two clients from relaying the same signed ClearMacro authorization and racing one another into onchain nonce/replay failures.

### Relayer Transactions Table

Keep `relayer_transactions`, but treat it as internal.

Add/ensure fields:

- `included_at text null`
- `receipt_json text null`

Keep `confirmed_at` for relayer finality.

If OpenZeppelin Relayer does not expose full receipt data, the worker may optionally fetch the receipt via app RPC after a hash is known. If implemented, use app RPC fallback and normalize into `receipt_json`.

### Audit Events

Rename `audit_events` to `relay_execution_events` if changing table names. Public event shape should be normalized and not expose raw OZ payloads.

Public lifecycle events should include only:

- state changes
- first transaction hash observed
- transaction hash replaced
- receipt observed
- terminal error set

Internal audit/debug events can remain richer but should not be returned by dapp endpoints unless sanitized.

## Internal State Helpers

Replace `src/tx/lifecycle.ts` with the new public state enum:

```ts
export const relayExecutionStates = [
  "accepted",
  "pending",
  "submitted",
  "included",
  "succeeded",
  "reverted",
  "rejected",
  "failed",
  "expired",
  "canceled",
] as const;
```

Terminal states:

- `succeeded`
- `reverted`
- `rejected`
- `failed`
- `expired`
- `canceled`

Allowed transitions must match the public table above.

Repository transition methods must support metadata updates without a state transition, specifically:

- setting `oz_transaction_id`
- setting/replacing current transaction hash
- appending to `transaction_hashes_json`
- setting normalized receipt
- setting normalized error

## Relayer Status Mapping

Replace `mapRelayerStatusToRequestState` with a projection that considers both relayer status and hash presence.

Input:

```ts
type RelayerProjectionInput = {
  status: string;
  statusReason: string | null;
  hash: string | null;
  confirmedAt: string | null;
  receipt?: NormalizedReceipt | null;
  requiredConfirmations: number | null;
};
```

Output:

```ts
type RelayerProjection = {
  state: RelayExecutionState;
  error?: RelayExecutionError;
};
```

Mapping:


| Relayer status / data                                    | Public state              | Notes                                                                              |
| -------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `pending` with no hash                                   | `pending`                 | Intent accepted by relayer or waiting internally.                                  |
| `sent` with no hash                                      | `pending`                 | Signed/sending but no public hash observed.                                        |
| `submitted` with no hash                                 | `pending`                 | Do not claim submitted without a hash.                                             |
| `pending`/`sent`/`submitted` with hash                   | `submitted`               | Hash exists; dapp can show explorer link.                                          |
| `inmempool` with hash                                    | `submitted`               | If OZ exposes this status.                                                         |
| `mined` with success receipt and confirmations not final | `included`                | If receipt/finality data supports this distinction.                                |
| `mined` with no receipt failure signal                   | `included` or `succeeded` | Use `included` only if confirmation policy is not complete; otherwise `succeeded`. |
| `confirmed`                                              | `succeeded`               | Relayer finality policy complete.                                                  |
| `failed` with revert/receipt-failed reason               | `reverted`                | Category `user`, retryable false.                                                  |
| receipt status `0`                                       | `reverted`                | Overrides generic failed mapping.                                                  |
| `failed` without revert signal                           | `failed`                  | Category `relayer` or `unknown`, retryable false after terminal.                   |
| `canceled`                                               | `canceled`                | Terminal.                                                                          |
| `expired`                                                | `expired`                 | Terminal.                                                                          |
| unknown non-terminal status with hash                    | `submitted`               | Preserve progress; log internal warning.                                           |
| unknown non-terminal status without hash                 | `pending`                 | Preserve progress; log internal warning.                                           |


Hash replacement behavior:

- If a poll observes a non-null hash different from `current_transaction_hash`, append it to `transaction_hashes_json` and set `current_transaction_hash`, even if the hash already appears earlier in the array.
- Do not create a new relay execution for a replacement hash.
- Append a sanitized event `transaction_hash_observed` for first hash and `transaction_hash_replaced` for later hashes.

## Worker Changes

### Submission Work Selection

Replace `listSubmittable` selection with:

```sql
SELECT * FROM relay_executions
WHERE terminal = 0
  AND oz_transaction_id IS NULL
  AND state IN ('accepted', 'pending')
ORDER BY created_at ASC
LIMIT ?
```

The worker should transition `accepted -> pending` before preflight/submission.

Before submission, re-check `validBefore`:

- If elapsed, transition to `expired`.
- If `validAfter` is in the future and delayed execution is not enabled, this should already have been rejected synchronously. If delayed execution is enabled later, keep `pending` until valid.

### Submission Success

After OpenZeppelin Relayer accepts the transaction intent:

- Persist `oz_transaction_id`.
- Upsert `relayer_transactions`.
- If `tx.hash` exists, set state `submitted` and record hash.
- If `tx.hash` is null, keep/set state `pending`.

### Submission Failure

Transient submit failures:

- Keep state `pending`.
- Store internal retry diagnostics.
- Append internal event `relayer_submit_retry_scheduled`.
- Retry according to policy.

Final submit failure:

- Transition to `failed` with normalized error:

```json
{
  "code": "RELAYER_SUBMIT_FAILED",
  "message": "Relayer did not accept transaction intent after retries.",
  "category": "relayer",
  "retryable": false
}
```

Deterministic preflight failure:

- Transition to `rejected` with normalized error:

```json
{
  "code": "PREFLIGHT_REVERTED",
  "message": "Preflight simulation reverted before submission.",
  "category": "user",
  "retryable": false
}
```

### Polling Work Selection

Replace `listPending` with a query for all non-terminal executions with `oz_transaction_id is not null`, not just state `pending`:

```sql
SELECT * FROM relay_executions
WHERE terminal = 0
  AND oz_transaction_id IS NOT NULL
  AND state IN ('pending', 'submitted', 'included')
ORDER BY updated_at ASC
LIMIT ?
```

On each poll:

1. Fetch the OZ transaction by internal relayer ID/transaction ID.
2. Upsert internal relayer transaction snapshot.
3. Normalize hash/receipt/gas/timestamp fields.
4. Project public state.
5. Update metadata first, then transition state if needed.
6. Append sanitized public lifecycle event if state/hash/receipt/error changed.

Polling errors:

- Do not change public state for transient polling errors.
- Append internal diagnostics.
- If policy determines the OZ transaction ID is permanently unqueryable, transition to `failed` with `RELAYER_TRANSACTION_NOT_FOUND`.

## API Route Implementation Changes

Files to update:

- `src/api/routes.ts`
- `src/api/schemas.ts`
- `src/api/errors.ts`
- `src/db/migrations.ts`
- `src/db/repositories.ts`
- `src/tx/lifecycle.ts`
- `src/relayer/mapper.ts`
- `src/relayer/worker.ts`
- `src/relayer/client.ts` if receipt/status fields need expansion
- `src/validation/clearmacro.ts` only for naming/types if needed
- `README.md`
- Existing specs that reference old endpoint/state names

Route structure:

- `POST /v1/relay-executions`
- `GET /v1/relay-executions/:id`
- `GET /v1/capabilities`
- health/readiness/metrics unchanged

Remove these routes entirely:

- `POST /v1/relay`
- `GET /v1/requests/:id`

Do not keep aliases or compatibility redirects.

Response schemas:

- TypeBox schemas must be strict enough for dapps to codegen against.
- Address fields should keep `^0x[0-9a-fA-F]{40}$`.
- Bytes fields should keep `^0x([0-9a-fA-F]{2})*$`.
- UInt-like values should be decimal strings.
- `transaction.hashes` should be an array of bytes32-like hex strings (`^0x[0-9a-fA-F]{64}$`).

Error handling:

- Include `category` and `retryable` in every API error.
- Do not include raw relayer errors in public messages if they may contain internal details. Store raw details internally.

## Capabilities Endpoint Changes

Keep `GET /v1/capabilities`, but make it dapp-oriented.

Response should include:

```ts
type Capabilities = {
  service: {
    name: "clearmacro-provider";
    version: string;
  };
  relayApi: {
    endpoint: "/v1/relay-executions";
    supportedKinds: ["clearMacroV1"];
    states: RelayExecutionState[];
    supportsIdempotencyKey: true;
    supportsWaitEndpoint: boolean;
  };
  chains: Array<{
    chainId: number;
    name: string;
    enabled: boolean;
    ready: boolean;
    forwarders: {
      clearMacroV1: `0x${string}`;
    };
    providers: string[];
    macros: Array<{
      address: `0x${string}`;
      name: string;
      enabled: boolean;
      supportedKinds: string[];
    }>;
  }>;
};
```

Do not expose `ozRelayerId` in capabilities.

## Dashboard Integration Guidance

The dapp should track provider executions by `id` immediately after create returns.

Suggested dapp adapter states:


| Provider state | Dashboard behavior                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `accepted`     | Show “Transaction accepted” / “Preparing transaction”.                                                  |
| `pending`      | Show existing pending spinner, but no explorer link yet.                                                |
| `submitted`    | Show explorer link using current `transaction.hash`, while keeping `id` as the tracked transaction key. |
| `included`     | Keep pending until provider finality or local receipt policy says success.                              |
| `succeeded`    | Mark pending update `hasTransactionSucceeded`, then wait for indexed state.                             |
| `reverted`     | Mark failed/reverted. Remove optimistic pending update.                                                 |
| `rejected`     | Show user-action failure, no explorer link.                                                             |
| `failed`       | Show provider/relayer failure, no retry unless dapp creates a fresh signed payload.                     |
| `expired`      | Show expired; user must sign a new payload.                                                             |
| `canceled`     | Show canceled.                                                                                          |


The dapp must not use `transaction.hash` as the primary ID for relayed executions. If the provider reports a new current hash while the execution is non-terminal, update only hash-derived display data such as explorer links. The provider execution tracker remains the source of truth from acceptance through indexed-state sync.

The existing Dashboard `transactionTracker` concept can be reused, but it should be generalized from "tracked transaction keyed by EVM hash" to "tracked execution keyed by stable execution ID". For wallet-broadcast transactions the execution ID can remain the EVM transaction hash. For relayed executions the execution ID should be the provider `id`, with `transaction.hash` stored as optional display/receipt metadata. A compatibility helper that waits for a hash and returns an ethers-like `TransactionResponse` can be useful for incremental migration, but it should be treated as a temporary adapter rather than the target architecture.

## Implementation Steps

1. Replace lifecycle enum and transition rules.
2. Rewrite TypeBox schemas for create execution, relay execution response, normalized error, transaction, and receipt.
3. Update error class/helper to include category and retryable.
4. Rewrite initial SQLite migration to `relay_executions`, updated `relayer_transactions`, and updated event table.
5. Update repositories and row mappers to new names and state enum.
6. Add repository helpers for metadata-only updates: transaction hash append, receipt set, relayer transaction ID set, normalized error set.
7. Replace `/v1/relay` with `/v1/relay-executions` route.
8. Replace `/v1/requests/:id` with `/v1/relay-executions/:id` route.
9. Add response mapper from internal row + relayer snapshot to public `RelayExecution`.
10. Update create route to persist `accepted` and run one bounded progress step before response.
11. Update worker submission flow to use `accepted/pending/submitted` states.
12. Update relayer status projection and polling flow.
13. Update capabilities response to remove OZ internals.
14. Update README and existing specs to remove old endpoint/state names.
15. Update tests for new schemas, transitions, idempotency, duplicate semantics, relayer no-hash flow, hash replacement, terminal success, revert, and preflight rejection.

## Test Plan

Unit tests:

- State transition helper accepts only specified transitions.
- Terminal states cannot transition.
- Relayer projection maps no-hash statuses to `pending`.
- Relayer projection maps hash statuses to `submitted`.
- Relayer projection maps `confirmed` to `succeeded`.
- Relayer projection maps receipt status `0` to `reverted`.
- Hash replacement appends current-hash changes and updates current hash.
- Reobserving a previously seen hash appends it again when it becomes current, preserving `transaction.hash === last(transaction.hashes)`.
- Error mapper sets `category` and `retryable` for every public error.

API integration tests with mocked relayer/RPC:

- Valid create returns `202` and `id`.
- Create returns `submitted` when relayer response contains a hash.
- Create returns `pending` when relayer response has no hash.
- Transient submit failure after persistence returns execution resource, not raw 503.
- Synchronous invalid payload returns `422` and creates no execution.
- Idempotency replay returns same execution.
- Idempotency conflict returns `409`.
- Semantic duplicate returns `409 DUPLICATE_EXECUTION`.
- Get execution hides OZ relayer IDs.
- Capabilities hides OZ relayer IDs.

Worker tests:

- Accepted execution transitions to pending before submission.
- Pending execution with relayer hash transitions to submitted.
- Submitted execution with replacement hash remains submitted and appends the current-hash change to `transaction.hashes`.
- Confirmed relayer status transitions to succeeded.
- Failed relayer status with revert-like reason transitions to reverted.
- Failed relayer status without revert signal transitions to failed.
- Polling transient error does not change public state.
- Permanently missing relayer transaction transitions to failed.
- Expired execution before submission transitions to expired.

Dashboard adapter tests, if/when implemented:

- Provider `pending` without hash renders pending UI without explorer link.
- Provider `submitted` exposes explorer link while keeping execution ID as the tracked entity key.
- Hash replacement updates displayed hash/link.
- Provider `succeeded` triggers pending-update success path.
- Provider `reverted/failed/rejected/expired/canceled` clears optimistic pending updates.

## Final Design Decisions

- Keep `included` in the public enum even if initially rare. It matches normal transaction lifecycle and supports future receipt polling.
- Echo `clientRequestId` and `metadata` always. They are dapp-provided correlation/restoration fields.
- Keep `clientRequestId` non-unique. Use `Idempotency-Key` for exactly-once semantics.
- Do not implement the wait endpoint in the first API update. Build a dapp/client helper first; add server-side wait only if real integration shows it reduces complexity.
- Remove old endpoint aliases instead of keeping compatibility shims.

