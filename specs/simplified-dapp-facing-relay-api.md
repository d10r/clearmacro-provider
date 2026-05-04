# Simplified Dapp-Facing Relay API Spec

## Goal

Define the next iteration of the `clearmacro-provider` public API with less accidental complexity for dapps such as the Superfluid Dashboard.

The core model is simple:

- The provider returns a stable relay execution `id` after validating and accepting a signed ClearMacro payload.
- The dapp tracks that `id` as the transaction/execution identity.
- The EVM transaction hash is optional metadata for explorer links and receipt correlation.
- Internal provider/relayer details stay internal.

This supersedes the more detailed `specs/dapp-facing-relay-api-update.md` where the two conflict.

## Design Principles

- Track relayed executions by provider `id`, not by EVM transaction hash.
- Keep the public state machine small and dapp-relevant.
- Do not expose provider worker queue states.
- Do not expose OpenZeppelin Relayer IDs or raw statuses.
- Do not expose hash history in the public API.
- Make `POST` perform synchronous validation and preflight before creating a public execution. Creation and relayer submission remain separate.
- Allow callers to explicitly request execution even when preflight simulation predicts a revert.
- Treat tx hash replacement as updating display metadata, not as a public lifecycle event the dapp must reason about.
- Do not require client-managed idempotency keys. Deduplicate exact signed authorization intents implicitly.
- Treat the ClearMacro provider name as deployment-global configuration, not per-chain or per-execution public data.

## Deployment Configuration

Each provider deployment has one global ClearMacro provider name, configured by the operator, ideally through environment/config such as `PROVIDER_NAME=macros.superfluid.eth`.

Rules:

- Dapps discover this value from `GET /v1/capabilities` and encode it into `payload.security.provider`.
- `POST /v1/relay-executions` rejects payloads whose `payload.security.provider` does not equal the configured global provider name.
- Public relay execution resources do not include the provider name because it is constant for the deployment.
- Internal audit logs may include the decoded provider name for troubleshooting rejected payloads.

## Forwarder Resolution

Clients do not provide a forwarder address when creating relay executions.

The provider resolves the forwarder from its loaded registry using:

```text
chainId -> registry.chains[chainId].forwarderAddress
```

For v1:

```text
kind = "clearMacroV1"
forwarderAddress = registry.chains[chainId].forwarderAddress
```

Rules:

- If `chainId` is unknown or disabled, reject before execution creation.
- If `kind` is unsupported for the chain or macro, reject before execution creation.
- Use the resolved forwarder address for digest reads, preflight simulation, deduplication, persistence, relayer submission, and response rendering.
- Return the resolved `forwarderAddress` in public relay execution responses for transparency.
- Return the resolved `forwarderAddress` per configured chain from `GET /v1/capabilities` so dapps can construct/sign the correct ClearMacro payload.

## Registry Configuration

The provider registry should contain only app-specific relay policy that cannot be reliably derived from the chain, the ClearMacro payload, or OpenZeppelin Relayer.

Minimal shape:

```ts
type Registry = {
  version: 1;
  chains: Array<{
    chainId: number;
    forwarderAddress: `0x${string}`;
    rpcUrls: string[];
    allowedMacros: Array<{
      domain: string;
      address: `0x${string}`;
    }>;
  }>;
};
```

Rules:

- Omit disabled chains from the registry instead of carrying `enabled` flags.
- `forwarderAddress` is per chain while only `clearMacroV1` exists. Reintroduce a kind-keyed forwarder map only when multiple relay kinds are actually implemented.
- `allowedMacros` is the core policy. It is keyed by both `payload.security.domain` and `payload.security.macroContract`, not by address alone.
- A request is allowed only if the decoded `(domain, macroContract)` pair exactly matches an entry in `allowedMacros` for the requested chain.
- `rpcUrls` must list at least one explicit RPC URL per chain. The provider does not substitute chain-library defaults; invalid or missing URLs fail registry load.
- Do not include `providerName`; it is deployment-global config.
- Do not include `ozRelayerId`; the app should discover the matching OZ Relayer resource at startup/readiness by querying OpenZeppelin Relayer and matching EVM `chain_id` to `chainId`. Startup/readiness must fail if zero or multiple active relayers match a chain, unless an explicit operational override is provided outside this registry.
- Do not include confirmations in the registry. Read the matched OpenZeppelin Relayer network's `required_confirmations` **once at startup** when binding relayers to the registry and persist that value with new relay executions. Startup must fail if OZ does not return a positive integer for a bound chain.
- Do not include chain names, macro names, macro enabled flags, per-chain provider names, client policy, or speculative future relay kinds.

## Public State Machine

Public states:

| State | Terminal | Meaning |
| --- | --- | --- |
| `pending` | no | Provider accepted the signed payload and will attempt execution. No EVM transaction hash is required yet. |
| `submitted` | no | At least one current EVM transaction hash is known. The dapp can show an explorer link. |
| `succeeded` | yes | Execution succeeded according to provider finality policy. |
| `reverted` | yes | An onchain transaction was included and reverted, or the relayer reported a revert/receipt failure. |
| `rejected` | yes | Provider/relayer deterministically rejected execution after creating the execution object, before network submission. Synchronous `POST` preflight failures should normally return an error instead of creating this public resource. |
| `failed` | yes | Provider/relayer infrastructure failed before a reliable onchain terminal outcome was known. |
| `expired` | yes | The ClearMacro validity window elapsed before execution could complete. |
| `canceled` | yes | Execution was canceled before a successful onchain terminal outcome was known. |

Allowed transitions:

| From | To |
| --- | --- |
| none | `pending` |
| `pending` | `submitted`, `rejected`, `failed`, `expired`, `canceled` |
| `submitted` | `submitted`, `succeeded`, `reverted`, `failed`, `expired`, `canceled` |

Notes:

- `submitted -> submitted` is allowed for current transaction hash replacement and metadata updates.
- Terminal states do not transition automatically.
- If later evidence contradicts a terminal state, append an internal audit event and alert; do not silently rewrite public history.
- There is no public `accepted` state. Public `pending` covers accepted-but-not-submitted and relayer-submission-in-progress.
- There is no public `included` state in v1. Until finality, keep the execution `submitted`.

## Endpoints

### Create Relay Execution

```text
POST /v1/relay-executions
```

Request body:

```ts
type CreateRelayExecutionRequest = {
  kind: "clearMacroV1";
  chainId: number;
  macroAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  payload: `0x${string}`;
  signature: `0x${string}`;
  value?: string;
  forceExecuteAfterPreflightRevert?: boolean;
  clientRequestId?: string;
  metadata?: Record<string, string>;
};
```

Create behavior:

1. Validate JSON schema and primitive formats.
2. Authenticate client if auth is enabled.
3. Resolve the forwarder from `(chainId, kind)`.
4. Decode ClearMacro payload.
5. Reject if `payload.security.macroContract` does not match `macroAddress`.
6. Validate registry policy: chain, resolved forwarder, allowed `(domain, macroContract)` pair, and global provider name.
7. Validate validity window. Reject already-expired or not-yet-valid payloads synchronously.
8. Read forwarder digest.
9. Apply implicit dedup lookup by `(chainId, forwarderAddress, signerAddress, digest)`.
10. Validate signature against the digest.
11. Check requested-chain readiness.
12. Run preflight simulation of the exact `runMacro` call using the resolved forwarder, macro, payload, signer, signature, relayer sender, and value.
13. If preflight deterministically reverts and `forceExecuteAfterPreflightRevert` is not `true`, return a synchronous error and do not create a public execution resource.
14. If preflight deterministically reverts and `forceExecuteAfterPreflightRevert` is `true`, persist execution as `pending` and mark internal metadata so the worker submits it despite the known preflight failure.
15. If preflight cannot run because app RPCs are unavailable, return a retryable synchronous error and do not create a public execution resource.
16. Persist execution as `pending` after preflight passes, or after preflight reverts only when force execution is explicitly requested.
17. Return `202` with the execution resource.

Do not submit to OpenZeppelin Relayer inside this HTTP request. The worker owns relayer submission and all later progress.

The provider must write internal audit/request logs for create attempts that fail after authentication, including policy failures, macro/payload mismatch, provider-name mismatch, validity-window failures, signature failures, readiness failures, preflight failures, and duplicate attempts that are not returned as visible `200` replays. Those logs are not public relay execution resources and are not returned from `GET /v1/relay-executions/:id`.

Force execution rules:

- `forceExecuteAfterPreflightRevert` defaults to `false`.
- The flag only bypasses deterministic preflight revert rejection. It must not bypass JSON schema validation, auth, registry policy, validity window checks, chain readiness, digest reads, signature validation, or malformed payload checks.
- The flag exists for debugging and for callers that intentionally want an onchain reverted transaction/trace.
- The provider should surface in the returned resource metadata or events that the execution was force-submitted after a predicted revert, but it should not expose raw simulation traces in the public API by default.
- The worker must not re-run preflight and reject the execution solely because the same forced preflight would revert. It may still fail before submission for infrastructure, expiration, relayer rejection, or policy reasons.

Response codes:

| Code | Meaning |
| --- | --- |
| `202` | Newly created relay execution. |
| `200` | Duplicate signed authorization intent; returns the existing execution. |
| `400` | Malformed request or unsupported shape. |
| `401` | Missing/invalid auth when auth is enabled. |
| `403` | Chain/macro/provider policy rejects before execution creation. |
| `409` | Duplicate signed authorization intent exists but cannot be revealed to this client. |
| `422` | Signature invalid, payload invalid, expired/not-yet-valid payload, or deterministic preflight revert. |
| `503` | Provider/chain/relayer readiness failure before execution creation. |

Specific validation rules:

- If the decoded `(payload.security.domain, payload.security.macroContract)` pair is not allowlisted for the requested chain, return `403 MACRO_NOT_ALLOWED` and create no public execution.
- If `payload.security.macroContract` does not equal `macroAddress`, return `422 INVALID_CLEAR_MACRO_PAYLOAD` and create no public execution.
- If `payload.security.provider` does not equal the provider's configured global `providerName`, return `403 PROVIDER_NOT_ALLOWED` and create no public execution.

Error codes:

| Code | HTTP | Category | Retryable | Meaning |
| --- | --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | `validation` | false | Malformed JSON, schema failure, invalid primitive format, or unsupported request shape. |
| `UNAUTHORIZED` | 401 | `auth` | false | Missing or invalid API authentication when auth is enabled. |
| `CHAIN_NOT_ALLOWED` | 403 | `validation` | false | Chain is not configured in the provider registry. |
| `MACRO_NOT_ALLOWED` | 403 | `validation` | false | Decoded `(domain, macroContract)` pair is not allowlisted for the requested chain. |
| `PROVIDER_NOT_ALLOWED` | 403 | `validation` | false | Payload provider name does not match this deployment's global provider name. |
| `DUPLICATE_EXECUTION` | 409 | `validation` | false | Same signed authorization intent exists but cannot be revealed to this caller. |
| `INVALID_CLEAR_MACRO_PAYLOAD` | 422 | `user` | false | Payload cannot be decoded or decoded macro contract does not match `macroAddress`. |
| `CLEAR_MACRO_EXPIRED` | 422 | `user` | false | `validBefore` is non-zero and has elapsed before acceptance. |
| `CLEAR_MACRO_NOT_YET_VALID` | 422 | `user` | true | `validAfter` is in the future. |
| `SIGNATURE_INVALID` | 422 | `user` | false | Signature is not valid for the resolved digest and signer. |
| `PREFLIGHT_REVERTED` | 422 | `user` | false | Preflight simulation predicts revert and force execution was not requested. |
| `PROVIDER_NOT_READY` | 503 | `provider` | true | Requested chain/provider infrastructure is not ready. |
| `RELAYER_UNAVAILABLE` | 503 | `relayer` | true | Relayer is unavailable or not ready. |
| `CHAIN_UNAVAILABLE` | 503 | `chain` | true | App RPCs required for digest, signature validation, or preflight are unavailable. |

### Get Relay Execution

```text
GET /v1/relay-executions/:id
```

Returns the relay execution resource.

Optional query:

| Parameter | Meaning |
| --- | --- |
| `include=events` | Include sanitized lifecycle events. |

### Capabilities

```text
GET /v1/capabilities
```

Returns the minimal information a dapp needs before constructing a ClearMacro payload.

Response body:

```ts
type Capabilities = {
  providerName: string;
  chains: Array<{
    chainId: number;
    forwarderAddress: `0x${string}`;
  }>;
};
```

Rules:

- `providerName` is global and is the exact value dapps must encode into `payload.security.provider`.
- Only include chains present in the registry.
- `forwarderAddress` is the provider-resolved ClearMacro forwarder for that chain.
- Do not include macros. Macro allowlisting is enforced at request time.
- Do not include readiness. Request-time readiness is enforced by `POST /v1/relay-executions`, and operational readiness belongs to `/readyz`.
- Do not include feature flags, public state names, relayer IDs, relayer status, or registry internals.

Do not expose `ozRelayerId`.

## Public Resource Shape

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
  nonce: string;
  value: string;

  validity: {
    validAfter: string;
    validBefore: string;
  };

  transaction?: {
    hash: `0x${string}`;
    from?: `0x${string}`;
    to: `0x${string}`;
    submittedAt?: string;
  };

  receipt?: {
    transactionHash: `0x${string}`;
    blockNumber: string;
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

- `forwarderAddress` is resolved by the provider from `(chainId, kind)` and returned for transparency. Clients do not provide it.
- The global provider name is not repeated on each execution response. Use `GET /v1/capabilities` if the dapp needs to display it.
- `transaction` is absent until a current EVM transaction hash is known.
- `transaction.hash` is mutable while the execution is non-terminal.
- Hash replacement only updates `transaction.hash` and optional internal history.
- The dapp must use `id` as the stable tracking key.
- `metadata` is echoed back because it is dapp-provided correlation/restoration data.
- Dapps must not put secrets in `metadata`.

## Error Body Shape

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

Identity rules:

- Exact authorization dedup replay returns the existing execution resource with `200` when the execution is visible to the caller.
- If the duplicate execution is not visible to the caller, return `409 DUPLICATE_EXECUTION` with `executionId: null` and do not reveal the existing execution ID elsewhere.

## Implicit Deduplication

The public API does not require an `Idempotency-Key` header.

Instead, the provider deduplicates exact signed authorization intents by the digest that the forwarder validates.

Dedup key:

```text
(chainId, forwarderAddress, signerAddress, digest)
```

Where:

```text
digest = forwarder.getDigest(macroAddress, payload)
```

Behavior:

- First valid request for a dedup key creates a new execution and returns `202`.
- Later requests with the same dedup key return the existing execution with `200` when visible to the caller.
- If a duplicate exists but is not visible to the caller, return `409 DUPLICATE_EXECUTION` with no leaked execution ID.
- Deduplication is a UX/retry mechanism, not replay security. Onchain replay protection remains the forwarder's responsibility.
- The dedup key intentionally does not use `nonce` alone, because nonce collisions can happen across different intents depending on how callers choose nonces.
- The dedup key intentionally does not use raw signature bytes, because ERC-1271 signatures are arbitrary authorization blobs and may not change predictably when the signed digest changes.

Canonical request hashing is still useful internally for audit logs, but it is not part of the public API contract:

- Normalize address fields to lowercase.
- Default missing `value` to `"0"`.
- Default missing `forceExecuteAfterPreflightRevert` to `false`.
- Sort object keys recursively, including `metadata` keys.
- Hash the normalized request body, not raw JSON bytes.

## Internal Request Audit Log

The provider must keep an internal audit log for authenticated create attempts, including attempts that do not create public relay executions.

Minimum fields:

- timestamp
- authenticated client ID or `anonymous`
- request body hash after canonicalization
- chain ID, kind, resolved forwarder address when available
- macro domain, macro address, signer address, provider name, nonce, digest when available
- outcome code such as `CREATED`, `DUPLICATE_REPLAYED`, `DUPLICATE_HIDDEN`, `MACRO_NOT_ALLOWED`, `PROVIDER_NOT_ALLOWED`, `INVALID_CLEAR_MACRO_PAYLOAD`, `SIGNATURE_INVALID`, `PREFLIGHT_REVERTED`, or `READINESS_UNAVAILABLE`
- public execution ID when one was created or safely replayed to the caller

Rules:

- Do not store raw signatures or payloads in the audit log unless operations explicitly enable sensitive debug logging.
- Do not expose the audit log through the public dapp API.
- Keep audit logging separate from public relay execution lifecycle events, because many rejected create attempts intentionally have no public execution resource.

## Worker Responsibilities

The worker owns all post-creation execution progress. `POST` has already run initial preflight before creating the execution, but the worker may still perform cheap safety rechecks if needed before submission.

Submission flow:

1. Select non-terminal executions with no internal relayer transaction ID and state `pending`.
2. Re-check `validBefore`; if elapsed, transition to `expired`.
3. Optionally re-run preflight or other cheap safety checks if configured and the execution was not force-created after preflight revert.
4. If a post-creation safety check deterministically rejects submission, transition to `rejected` with normalized error.
5. If a post-creation safety check cannot run because RPC is unavailable, leave `pending` and retry later.
6. Submit transaction intent to OpenZeppelin Relayer.
7. Persist internal relayer transaction ID.
8. If a transaction hash is returned, set public state to `submitted` and set `transaction.hash`.
9. If no transaction hash is returned, keep public state `pending`.

Polling flow:

1. Select non-terminal executions with internal relayer transaction ID and state `pending` or `submitted`.
2. Poll OpenZeppelin Relayer by internal transaction ID.
3. Normalize current transaction hash, receipt, timestamps, and terminal error if any.
4. If a new current hash is observed, update internal hash history and public `transaction.hash`.
5. Project public state:
   - no hash and non-terminal relayer status -> `pending`
   - hash and non-terminal relayer status -> `submitted`
   - relayer final success / successful receipt -> `succeeded`
   - receipt status failed / revert-like status reason -> `reverted`
   - relayer canceled -> `canceled`
   - relayer expired -> `expired`
   - terminal infrastructure failure -> `failed`
6. Do not change public state for transient polling errors.

Transition note:

- If a poll observes both the first transaction hash and a terminal outcome, update metadata first, then transition through a valid path or use a transition helper that supports `pending -> submitted -> terminal` atomically.

## Internal Persistence

Keep internal data richer than the public API.

`relay_executions` should include at least:

- public fields needed for the response
- internal `oz_relayer_id`
- internal `oz_transaction_id`
- internal current transaction hash
- internal transaction hash history JSON, optional
- normalized receipt JSON
- normalized error JSON
- timestamps

`relayer_transactions` should remain internal and may store raw OZ snapshots for debugging.

Public API responses must not expose:

- `ozRelayerId`
- `ozTransactionId`
- raw OZ status
- raw OZ response JSON
- transaction hash history

## Dashboard Integration Guidance

Generalize the existing Dashboard transaction tracker from “tracked transaction keyed by EVM hash” to “tracked execution keyed by stable ID”.

For wallet-broadcast transactions:

```ts
id = transactionHash
transaction.hash = transactionHash
```

For relayed executions:

```ts
id = relayExecution.id
transaction.hash = relayExecution.transaction?.hash
```

Dashboard behavior:

| Provider state | Dashboard behavior |
| --- | --- |
| `pending` | Spinner, no explorer link unless `transaction.hash` exists. |
| `submitted` | Spinner plus explorer link. |
| `succeeded` | Mark execution succeeded, then wait for indexed data/subgraph sync. |
| `reverted` | Show reverted failure and clear optimistic pending update. |
| `rejected` | Show deterministic post-creation rejection; no explorer link required. Most preflight failures should be shown from the original `POST` error instead. |
| `failed` | Show provider/relayer failure. User must create a fresh signed payload to retry. |
| `expired` | Show expired. User must sign a fresh payload. |
| `canceled` | Show canceled. |

## Tests Required

API tests:

- Valid create returns `202 pending` with stable `id`.
- Exact signed authorization replay returns `200` and the same execution when visible to the caller.
- Exact signed authorization duplicate returns `409 DUPLICATE_EXECUTION` and does not reveal cross-client IDs when not visible to the caller.
- Different payloads with the same decoded nonce produce different digests and are not deduped by the provider.
- ERC-1271-compatible dedup uses digest, not raw signature bytes.
- Synchronous invalid payload/signature/expiry/preflight failures create no public execution.
- `forceExecuteAfterPreflightRevert: true` creates `202 pending` after deterministic preflight revert.
- Force execution does not bypass invalid payload, invalid signature, policy, expiry, or readiness failures.
- Failed authenticated create attempts are recorded in the internal request audit log without creating public executions.
- `GET /v1/relay-executions/:id` hides OZ internals.
- Capabilities returns only global `providerName` and configured chain forwarders.

Worker tests:

- Pending execution with relayer response lacking hash remains `pending`.
- Pending execution with relayer response containing hash becomes `submitted`.
- Pending execution with no initial hash can later become `submitted`.
- Pending execution with no initial hash can later become `succeeded` or `reverted` without getting stuck.
- Submitted execution with replacement hash remains `submitted` and updates current public hash.
- Confirmed/success receipt transitions to `succeeded`.
- Failed receipt/revert reason transitions to `reverted`.
- Generic relayer failure transitions to `failed`.
- Expired before submission transitions to `expired`.
- Transient post-creation safety-check/submit/poll errors do not expose malformed public errors.

Receipt normalization tests:

- Accept status forms `0`, `"0"`, `"0x0"` as reverted.
- Accept status forms `1`, `"1"`, `"0x1"` as success.
- Convert hex `blockNumber` and `gasUsed` to decimal strings.
