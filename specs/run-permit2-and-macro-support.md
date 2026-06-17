# Spec: Add `runPermit2AndMacro` Relay Support

## Goal

Add provider support for relaying `ClearMacroForwarderV1WithPermit2.runPermit2AndMacro(...)` while preserving the existing `clearMacroV1` / `runMacro(...)` API behavior.

The implementation should introduce a second relay kind for Permit2-backed ClearMacro executions. It should keep the request shape simple: clients provide the Permit2 permit and signature, while the provider derives the ClearMacro Permit2 witness fields from the configured forwarder, macro, payload, and `upgradeSuperToken`.

## Non-Goals

- Do not replace or break `kind: "clearMacroV1"`.
- Do not require clients to submit `witness` or `witnessTypeString`.
- Do not add a separate endpoint unless the existing endpoint becomes genuinely hard to maintain. The preferred API is still `POST /v1/relay-executions`.
- Do not rely on `forceExecuteAfterPreflightRevert` to bypass Permit2 signature validation.

## Contract Surface

The Permit2 forwarder entrypoint is:

```solidity
function runPermit2AndMacro(
    Permit2Context calldata permit2Context,
    IClearMacro m,
    bytes calldata encodedPayload
) external payable returns (bool);
```

`Permit2Context` is:

```solidity
struct Permit2Context {
    IPermit2.PermitTransferFrom permit;
    address owner;
    bytes32 witness;
    string witnessTypeString;
    bytes signature;
    address spender;
    address upgradeSuperToken;
}
```

Provider API clients should not send `owner`, `witness`, or `witnessTypeString`:

- `owner` is `signerAddress`.
- `witness` is `getPermit2WitnessStructHash(macroAddress, payload, upgradeSuperToken)`.
- `witnessTypeString` is `getPermit2WitnessTypeString(macroAddress, payload)`.

## API Shape

Extend `CreateRelayExecutionRequestSchema` into a discriminated union on `kind`.

Existing kind stays unchanged:

```json
{
  "kind": "clearMacroV1",
  "chainId": 11155420,
  "macroAddress": "0x1111111111111111111111111111111111111111",
  "signerAddress": "0x2222222222222222222222222222222222222222",
  "payload": "0x1234",
  "signature": "0xabcdef",
  "value": "0"
}
```

Add:

```json
{
  "kind": "clearMacroPermit2V1",
  "chainId": 11155420,
  "macroAddress": "0x1111111111111111111111111111111111111111",
  "signerAddress": "0x2222222222222222222222222222222222222222",
  "payload": "0x1234",
  "permit2": {
    "permit": {
      "permitted": {
        "token": "0x3333333333333333333333333333333333333333",
        "amount": "1000000"
      },
      "nonce": "123",
      "deadline": "1760000000"
    },
    "spender": "0x4444444444444444444444444444444444444444",
    "upgradeSuperToken": "0x5555555555555555555555555555555555555555",
    "signature": "0xabcdef"
  },
  "value": "0"
}
```

Field rules:

- `kind` is required and must be either `clearMacroV1` or `clearMacroPermit2V1`.
- Shared optional fields keep their existing meaning for both kinds:
  - `value` defaults to `"0"` when omitted.
  - `forceExecuteAfterPreflightRevert` only affects deterministic preflight reverts; it does not bypass auth, policy, signature, validity, readiness, or payload validation.
  - `clientRequestId` is an optional dapp correlation ID and is not used for deduplication.
  - `metadata` is optional dapp-provided string metadata and must not contain secrets.
- `signature` remains required for `clearMacroV1`.
- Top-level `signature` must not be accepted for `clearMacroPermit2V1`; Permit2 authorization lives at `permit2.signature`.
- `permit2` is required for `clearMacroPermit2V1` and must not be accepted for `clearMacroV1`.
- `permit2.permit.permitted.token`, `permit2.spender`, and `permit2.upgradeSuperToken` are EVM addresses.
- `permit2.permit.permitted.amount`, `permit2.permit.nonce`, and `permit2.permit.deadline` are decimal unsigned integer strings.
- `permit2.signature` is hex bytes.
- `signerAddress` is the Permit2 `owner` for `clearMacroPermit2V1`.
- Use the zero address for witness-only mode: `upgradeSuperToken = 0x0000000000000000000000000000000000000000`.
- In implied-upgrade mode (`upgradeSuperToken != zero address`), require `permit2.spender` to equal the provider-resolved `forwarderAddress`. Reject mismatches before persistence.
- In witness-only mode (`upgradeSuperToken == zero address`), preserve the requested `permit2.spender` address instead of replacing it with `forwarderAddress`; it is part of the Permit2 signed digest.

## Response Shape

Keep `RelayExecutionResponseSchema` mostly unchanged. It already includes:

- `kind`
- `signerAddress`
- `payload`-derived nonce and validity
- `forwarderAddress`
- transaction and receipt lifecycle fields

Do not echo the raw Permit2 signature or full `permit2` object in public responses.

## Capabilities

Extend `GET /v1/capabilities` so clients can discover Permit2 relay support.

Recommended minimal addition per chain:

```json
{
  "chainId": 11155420,
  "forwarderAddress": "0x...",
  "supportedKinds": ["clearMacroV1", "clearMacroPermit2V1"],
  "macroPolicy": { "mode": "open" }
}
```

Backward compatibility:

- Existing clients ignore `supportedKinds`.
- If the provider cannot support Permit2 on a chain, return only `["clearMacroV1"]`.
- If implementation does not add per-chain config, treat all configured chains as Permit2-capable only when the configured forwarder is expected to be `ClearMacroForwarderV1WithPermit2`.

## Data Model

The database already has `relay_executions.permit2_json`.

For `clearMacroV1`:

- Continue storing `permit2_json = null`.

For `clearMacroPermit2V1`:

- Store a canonical JSON object with only request-provided Permit2 fields:

```json
{
  "permit": {
    "permitted": {
      "token": "0x...",
      "amount": "1000000"
    },
    "nonce": "123",
    "deadline": "1760000000"
  },
  "spender": "0x...",
  "upgradeSuperToken": "0x...",
  "signature": "0x..."
}
```

Normalize addresses to lowercase before storage. For witness-only mode, this means preserving the requested `spender` address semantically, not preserving checksum casing.

Do not store `witness` or `witnessTypeString` unless there is a debugging need. Derive them at creation and worker submission time from chain state to avoid stale or inconsistent stored derived fields. If determinism across delayed submission is a concern, store them after derivation and use stored values in the worker; in that case, include tests that prove the worker uses the persisted derived values.

## Digest, Deduplication, and Signature Validation

`clearMacroV1` currently deduplicates by the ClearMacro digest from `getDigest(macro, payload)`. That remains unchanged.

For `clearMacroPermit2V1`, deduplicate by a Permit2-specific authorization digest, not just the ClearMacro digest. The ClearMacro digest is not the signed digest for this path.

Recommended dedupe key input:

- `chainId`
- `forwarderAddress`
- `signerAddress` / Permit2 owner
- computed Permit2 digest

The Permit2 digest is:

```solidity
keccak256(
  abi.encodePacked(
    "\x19\x01",
    IPermit2(PERMIT2).DOMAIN_SEPARATOR(),
    keccak256(
      abi.encode(
        keccak256(
          abi.encodePacked(
            "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
            witnessTypeString
          )
        ),
        keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted)),
        spender,
        permit.nonce,
        permit.deadline,
        witness
      )
    )
  )
)
```

Implementation notes:

- Add helpers to read `getPermit2WitnessStructHash(...)` and `getPermit2WitnessTypeString(...)` from the configured forwarder.
- Add a helper to read `DOMAIN_SEPARATOR()` from canonical Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
- Compute the Permit2 digest in TypeScript using `viem` ABI encoding and hashing.
- Reuse the existing `validateRelaySignature` style so EOA and ERC-1271 owners are both supported.
- Treat signature validation RPC failures as `503 CHAIN_UNAVAILABLE`, matching existing behavior.
- Treat invalid Permit2 signatures as `422 SIGNATURE_INVALID`.

Important: keep Permit2 signature validation separate from preflight. Otherwise `forceExecuteAfterPreflightRevert: true` could accidentally let invalid Permit2 signatures be persisted.

## Validation Flow

Refactor the current create route into shared and kind-specific steps.

Shared steps:

1. Authenticate API caller.
2. Validate TypeBox request schema.
3. Resolve `chainConfig` and configured `forwarderAddress`.
4. Decode `payload` with `decodeClearMacroPayload`.
5. Require `payload.security.macroContract == macroAddress`.
6. Require `payload.security.provider == providerName`.
7. Check `validAfter` / `validBefore` against current time.
8. Check macro allowlist/open policy with `assertMacroAllowed`.
9. Check chain readiness.
10. Resolve `ozRelayerId`, `relayerSigner`, and required confirmations.

`clearMacroV1`-specific steps:

1. Read ClearMacro digest with `getForwarderDigest`.
2. Deduplicate by ClearMacro digest.
3. Validate top-level `signature`.
4. Preflight `runMacro`.
5. Persist with `signature = body.signature`, `permit2Json = null`.

`clearMacroPermit2V1`-specific steps:

1. Validate `permit2` shape and normalize addresses.
2. Derive `witness` and `witnessTypeString` from forwarder views.
3. Compute Permit2 digest.
4. Deduplicate by Permit2 digest.
5. Validate `permit2.signature` against `signerAddress` and Permit2 digest.
6. Preflight `runPermit2AndMacro`.
7. Persist with `signature = permit2.signature` to satisfy the existing non-null column and preserve audit value, but treat `permit2Json` as the source of truth for Permit2 submissions.

Prefer explicit code paths over clever overloading. For example:

- `buildRunMacroCalldata(...)`
- `buildRunPermit2AndMacroCalldata(...)`
- `preflightRunMacro(...)`
- `preflightRunPermit2AndMacro(...)`

## Calldata Builder

Update the ABI sync script and vendored ABI:

- Replace the ABI source from `bundled.ClearMacroForwarderV1` to `bundled.ClearMacroForwarderV1WithPermit2` if the build artifact exposes it.
- If the bundle key differs, update the script accordingly and fail loudly when the key is missing.
- Keep the exported name stable if practical, but rename the source file/export to avoid confusion if a larger change is acceptable.

Add a builder:

```ts
export type Permit2ContextInput = {
  permit: {
    permitted: {
      token: string;
      amount: string;
    };
    nonce: string;
    deadline: string;
  };
  owner: string;
  witness: string;
  witnessTypeString: string;
  signature: string;
  spender: string;
  upgradeSuperToken: string;
};

export function buildRunPermit2AndMacroCalldata(input: {
  permit2Context: Permit2ContextInput;
  macro: string;
  encodedPayload: string;
}): string;
```

Encode:

```ts
encodeFunctionData({
  abi: clearMacroForwarderV1Abi,
  functionName: "runPermit2AndMacro",
  args: [permit2Context, macro, encodedPayload],
});
```

Use `BigInt(...)` for `amount`, `nonce`, and `deadline` when constructing ABI tuple values.

## Preflight

Add `preflightRunPermit2AndMacro` next to `preflightRunMacro`.

It should call:

```ts
client.simulateContract({
  address: forwarder,
  abi: clearMacroForwarderV1Abi,
  functionName: "runPermit2AndMacro",
  args: [permit2Context, macro, encodedPayload],
  account: relayerSigner,
  value: BigInt(msgValue),
});
```

Classification should match `preflightRunMacro`:

- success -> `"ok"`
- deterministic revert -> `"deterministic_revert"`
- RPC / network issue -> `"rpc_unavailable"`

Do not special-case Permit2 reverts in the first implementation unless a product error code is needed. Invalid signatures should already be caught before preflight.

## Worker

Update `processRelayerWorkerTick`:

- For `execution.kind === "clearMacroV1"`, keep existing behavior.
- For `execution.kind === "clearMacroPermit2V1"`:
  - Parse `execution.permit2Json`.
  - Derive or load `witness` and `witnessTypeString`.
  - Run `preflightRunPermit2AndMacro` unless `forceAfterPreflightRevert === 1`.
  - Submit calldata from `buildRunPermit2AndMacroCalldata`.
- If `permit2Json` is missing or malformed for a Permit2 execution, transition to `failed` with a provider-category terminal error.
- Preserve expiry handling before submission.
- Preserve transient submit retry behavior.

## Test Plan

The project uses Vitest and test fixtures rather than live dependencies for most coverage:

- Unit tests: `pnpm run test:unit`
- Integration tests: `pnpm run test:integration`
- API e2e stub journey: `pnpm run test:e2e`
- Full Docker/Anvil/OZ stack: `pnpm run test:e2e:stack`
- Full CI-style command: `pnpm run test:ci`

Add coverage in the same style.

### Unit Tests

#### `test/unit/builder.test.ts`

Add tests for `buildRunPermit2AndMacroCalldata`:

- Encodes `runPermit2AndMacro` with:
  - nested `permit.permitted.token`
  - nested `permit.permitted.amount`
  - `permit.nonce`
  - `permit.deadline`
  - `owner`
  - `witness`
  - `witnessTypeString`
  - `signature`
  - `spender`
  - `upgradeSuperToken`
  - `macro`
  - `encodedPayload`
- Decodes using `decodeFunctionData` and asserts:
  - `functionName === "runPermit2AndMacro"`
  - decoded owner equals input owner
  - decoded signature equals input signature
  - decoded macro and payload match
  - uint string inputs became expected bigint values
- Keep the existing `runMacro` encoding test unchanged.

#### New Permit2 digest/helper unit tests

If Permit2 digest helpers are introduced, add a dedicated unit test file, for example `test/unit/permit2.test.ts`:

- Computes the same digest for a fixed fixture twice.
- Changes digest when `spender` changes.
- Changes digest when `permit.nonce` changes.
- Changes digest when `witness` changes.
- Rejects invalid decimal strings before digesting.
- Lowercases normalized address fields where intended.

#### Schema tests

Add or extend API schema tests:

- `clearMacroV1` accepts top-level `signature`.
- `clearMacroV1` rejects a `permit2` object.
- `clearMacroPermit2V1` accepts `permit2` and rejects missing `permit2`.
- `clearMacroPermit2V1` rejects top-level `signature`.
- Reject bad address fields under `permit2`.
- Reject non-decimal `amount`, `nonce`, and `deadline`.
- Reject malformed `permit2.signature`.

### Integration Tests

#### `test/integration/api.test.ts`

Extend `createTestHarness` to accept dependency overrides for:

- deriving Permit2 witness/type string, or lower-level RPC helper(s)
- validating Permit2 signatures
- Permit2 preflight

Add tests:

- Accepts valid `clearMacroPermit2V1` request and returns `202 pending`.
- Persists `kind = "clearMacroPermit2V1"` and non-null `permit2Json`.
- Response does not expose raw `permit2.signature`.
- Replays identical Permit2 signed intent with `200` for same caller.
- Returns `409 DUPLICATE_EXECUTION` for same Permit2 digest from a different authenticated client, without leaking the execution id.
- Allows two Permit2 requests with the same ClearMacro payload when Permit2 nonce/signature/digest differ.
- Rejects invalid Permit2 signature with `422 SIGNATURE_INVALID`.
- If Permit2 witness derivation RPC fails, returns `503 CHAIN_UNAVAILABLE`.
- If Permit2 domain separator read or ERC-1271 validation RPC fails, returns `503 CHAIN_UNAVAILABLE`.
- Rejects implied-upgrade mode when `permit2.spender` is not the provider-resolved `forwarderAddress`.
- Accepts witness-only mode with arbitrary `permit2.spender`.
- `forceExecuteAfterPreflightRevert: true` still does not bypass:
  - macro policy
  - provider mismatch
  - invalid Permit2 signature
  - invalid Permit2 request shape
- `forceExecuteAfterPreflightRevert: true` does allow persistence after a deterministic Permit2 preflight revert, mirroring `clearMacroV1`.
- Open macro policy accepts a Permit2 request for a macro not in the allowlist, while still rejecting macro/payload mismatch.
- `GET /v1/capabilities` includes `supportedKinds` and lists `clearMacroPermit2V1`.

Use `app.inject`, `buildRelayPayload`-style fixture helpers, and existing status/error code assertions.

#### `test/integration/worker.test.ts`

Add tests:

- Pending `clearMacroPermit2V1` execution submits a transaction whose `data` decodes to `runPermit2AndMacro`.
- Worker passes the relayer signer, msg value, macro, payload, owner, and Permit2 context into Permit2 preflight.
- Worker rejects/keeps pending on deterministic/rpc Permit2 preflight results exactly like current `runMacro` behavior.
- Worker marks malformed or missing `permit2Json` as `failed` with terminal provider error.
- Worker preserves existing transient submit retry behavior for Permit2 executions.
- Worker preserves expiry behavior before submission for Permit2 executions.
- Existing `clearMacroV1` worker tests remain green.

#### `test/integration/db.test.ts`

Add repository coverage:

- Creates and reads an execution with non-null `permit2Json`.
- Existing rows with `permit2Json = null` still map correctly.
- Dedup lookup works for Permit2 digest values.

### API E2E Tests

#### `test/e2e/relay-api.e2e.test.ts`

Add a stubbed full journey:

- `GET /v1/capabilities` shows `clearMacroPermit2V1`.
- `POST /v1/relay-executions` with Permit2 returns `202`.
- Worker tick submits via stub relayer.
- `GET /v1/relay-executions/:id` reaches `succeeded` with success receipt.
- Transaction calldata captured by the stub relayer decodes to `runPermit2AndMacro`.

Keep this test dependency-injected and fast, like the existing e2e test.

### Full Stack E2E

#### Fixture contracts

Update `test/fixtures/contracts/src/FullStackE2EDeployer.sol`:

- Deploy `ClearMacroForwarderV1WithPermit2` instead of `ClearMacroForwarderV1`.
- Continue granting the provider role to the relayer signer.
- Continue returning one `forwarderAddress`.

Add fixture support for Permit2:

- Witness-only mode (`upgradeSuperToken = zero address`) needs no token transfer; useful for validating signature and witness derivation without ERC-20 setup.
- Implied-upgrade mode (`upgradeSuperToken != zero address`) requires an ERC-20 underlying token, a wrapper SuperToken, signer underlying funding, and Permit2 approval. This is the production rollout path and must be covered by full-stack E2E.

#### `test/e2e/relay-stack.e2e.test.ts`

Add a second full-stack test or extend the existing one:

- Deploy the Permit2-capable forwarder.
- Build a normal ClearMacro payload.
- Read:
  - `getPermit2WitnessStructHash(macro, payload, zeroAddress)`
  - `getPermit2WitnessTypeString(macro, payload)`
  - Permit2 `DOMAIN_SEPARATOR()`
- Sign the Permit2 witness digest with the request signer.
- POST `kind: "clearMacroPermit2V1"` with witness-only `upgradeSuperToken = zeroAddress`.
- Poll until `succeeded` with success receipt.

This test should be gated behind the existing `RUN_STACK_E2E=1` flag and should not run in normal `pnpm run test:e2e`.

### Negative Full-Stack Cases

Do not over-expand stack e2e. Prefer integration tests for most negatives. If adding one stack negative, choose one high-value case:

- invalid Permit2 signature returns `422 SIGNATURE_INVALID` before persistence; or
- implied-upgrade spender mismatch returns a validation error before persistence.

## Coverage Hardening Before Production

This section is for implementers taking over from a partially completed Permit2 implementation. Some core pieces may already exist, such as:

- `src/chain/permit2.ts` with Permit2 request normalization, digest computation, and `Permit2Context` construction.
- `buildRunPermit2AndMacroCalldata` in `src/tx/builder.ts`.
- Permit2 request schema support and `clearMacroPermit2V1` admission branching.
- `preflightRunPermit2AndMacro`, witness derivation helpers, and Permit2 domain separator reads.
- Basic Permit2 unit tests, a few API integration tests, and a worker test proving `runPermit2AndMacro` calldata submission.

Those pieces are necessary but not sufficient for high production confidence. Before enabling Permit2 in production, close the gaps below.

### 1. Add Stubbed Permit2 API E2E

File: `test/e2e/relay-api.e2e.test.ts`

Add a fast dependency-injected Permit2 journey matching the existing `clearMacroV1` journey:

1. Use `createTestHarness` with the normal stub relayer.
2. Build a `clearMacroPermit2V1` payload using fixture helpers.
3. `POST /v1/relay-executions` and assert `202`, `state: "pending"`, and `kind: "clearMacroPermit2V1"`.
4. Run `processRelayerWorkerTick`.
5. Capture the stub relayer's submitted transaction data and decode it with the vendored forwarder ABI.
6. Assert `functionName === "runPermit2AndMacro"`.
7. `GET /v1/relay-executions/:id` and assert terminal `succeeded` with success receipt.

This is the minimum e2e test that proves API admission, persistence, worker submission, relayer polling, and public response projection work together for Permit2.

### 2. Add Full Stack Witness-Only Permit2 E2E

Files:

- `test/fixtures/contracts/src/FullStackE2EDeployer.sol`
- `test/e2e/relay-stack.e2e.test.ts`

Update the stack fixture so the deployed forwarder supports `runPermit2AndMacro`:

1. Deploy `ClearMacroForwarderV1WithPermit2` instead of `ClearMacroForwarderV1`.
2. Keep granting the configured provider role to the relayer signer.
3. Keep returning the same `forwarderAddress` field so provider config code does not need a separate Permit2 address.

Add a witness-only stack test behind `RUN_STACK_E2E=1`:

1. Start the existing Docker/Anvil/OZ stack.
2. Build a normal ClearMacro payload with `provider = "macros.superfluid.eth"`.
3. Read `getPermit2WitnessStructHash(macro, payload, zeroAddress)` from the forwarder.
4. Read `getPermit2WitnessTypeString(macro, payload)` from the forwarder.
5. Read Permit2 `DOMAIN_SEPARATOR()` from `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
6. Compute the Permit2 witness-transfer digest with the same helper used by the API.
7. Sign that digest with the request signer.
8. POST `kind: "clearMacroPermit2V1"` with `upgradeSuperToken = zeroAddress`.
9. Poll until terminal `succeeded` with a success receipt.

Witness-only is a useful regression test because it verifies real witness derivation, real Permit2 signature validation, real preflight, OZ submission, and on-chain execution without requiring ERC-20 funding/approval setup. Production rollout also requires the implied-upgrade stack test described in section 9.

### 3. Add Contract-Backed Permit2 Preflight Test

Files:

- `test/fixtures/contracts/src/RelayerLikePreflightForwarder.sol` or a new `RelayerLikePermit2PreflightForwarder.sol`
- `test/integration/preflight-anvil.test.ts`

The existing `runMacro` preflight test deploys a small fixture to Anvil and proves that `preflightRunMacro` classifies the relevant relayer-time conditions. Add the same style of test for `preflightRunPermit2AndMacro`.

The fixture should expose `runPermit2AndMacro(Permit2Context, address, bytes)` and check at least:

- `msg.sender` equals the expected relayer signer.
- `macro` equals the expected macro.
- `encodedPayload` hash equals the expected payload hash.
- `permit2Context.owner` equals the expected signer.
- `permit2Context.signature` hash equals the expected signature hash.
- `permit2Context.witness` equals the expected witness.
- `permit2Context.witnessTypeString` hash equals the expected witness type string hash.
- `msg.value` equals the expected value.

Test cases:

- Valid input returns `"ok"`.
- Wrong signature, owner, witness, relayer signer, or msg value returns `"deterministic_revert"`.
- Unreachable RPC returns `"rpc_unavailable"` if practical to exercise without slowing the suite.

This catches ABI tuple-shape mistakes and account/value simulation mistakes that unit decode tests do not catch.

### 4. Expand Permit2 API Negative Coverage

File: `test/integration/api.test.ts`

The current basic Permit2 API tests are not enough. Add focused cases for:

- Cross-client duplicate hiding: same Permit2 digest from two authenticated clients returns `409 DUPLICATE_EXECUTION` and `executionId: null` for the second client.
- Witness derivation RPC failure: override `getPermit2WitnessStructHash` or `getPermit2WitnessTypeString` to throw and assert `503 CHAIN_UNAVAILABLE`.
- Permit2 domain separator failure: override `getPermit2DomainSeparator` to throw and assert `503 CHAIN_UNAVAILABLE`.
- Signature validation RPC failure: override `validateRelaySignature` to throw and assert `503 CHAIN_UNAVAILABLE`.
- `forceExecuteAfterPreflightRevert: true` with invalid Permit2 signature still returns `422 SIGNATURE_INVALID` and does not persist.
- `forceExecuteAfterPreflightRevert: true` with deterministic Permit2 preflight revert returns `202` and sets `metadata.forceSubmittedAfterPreflightRevert = "true"`.
- Witness-only mode accepts arbitrary `permit2.spender` when `upgradeSuperToken` is the zero address.
- Open macro policy accepts a Permit2 request for a non-allowlisted macro while still rejecting macro/payload mismatch.
- Schema rejects `clearMacroPermit2V1` with top-level `signature`.
- Schema rejects `clearMacroPermit2V1` with missing `permit2`.
- Schema rejects `clearMacroV1` with a `permit2` object if extra properties are disallowed by the schema; if TypeBox/Fastify currently allows extras, either make the schema strict or explicitly document that extra fields are ignored.
- Schema rejects malformed Permit2 addresses, non-decimal `amount`/`nonce`/`deadline`, and malformed `permit2.signature`.

Keep these as `app.inject` tests using harness overrides. Do not use real RPCs here.

### 5. Expand Permit2 Worker Coverage

File: `test/integration/worker.test.ts`

The current worker Permit2 test should prove successful calldata submission. Add cases for the branch-specific failures and retries:

- Permit2 preflight returns `"deterministic_revert"`: transition to `rejected`, set a terminal user error, and do not submit.
- Permit2 preflight returns `"rpc_unavailable"`: keep execution pending, append `preflight_retry_scheduled`, and do not submit.
- `forceAfterPreflightRevert = 1`: skip Permit2 preflight and submit.
- Missing `permit2Json`: transition to `failed` with `INVALID_PERMIT2_STATE`.
- Malformed `permit2Json`: transition to `failed` with `INVALID_PERMIT2_STATE`.
- Witness/context resolution throws in the worker: keep pending and append retry event.
- Expired Permit2 execution before submission: transition to `expired`, same as `clearMacroV1`.
- Transient submit failures still retry and eventually fail after `submitRetryCount`, same as `clearMacroV1`.

These tests should stub `resolvePermit2Context`, `preflightPermit2Simulation`, and `relayerClient.submitTransaction`; they do not need Anvil.

### 6. Add DB Persistence Coverage

File: `test/integration/db.test.ts`

Add repository tests for:

- Creating and reading a row with non-null `permit2Json`.
- Existing `clearMacroV1` rows with `permit2Json = null` still map correctly.
- `findByDedupKey` works with a Permit2 digest.

This is simple but important because worker correctness depends on persisted `permit2_json`.

### 7. Add Permit2 Signature Validation Integration

File: `test/integration/signature-validation.test.ts`

The generic `validateRelaySignature` helper can validate any digest, but production confidence is higher if the Permit2 digest path is represented directly:

1. Compute a Permit2 digest with `computePermit2Digest`.
2. Sign it with an EOA and assert validation succeeds.
3. Use a wrong signature and assert validation fails.
4. If the existing ERC-1271 fixture is reusable, validate an ERC-1271 signature over a Permit2 digest as well.

This test should not duplicate every crypto unit test; its purpose is proving the Permit2 digest output is accepted by the shared EOA/ERC-1271 validation path.

### 8. Add Canonical Body and Funding Coverage If Those Paths Branch

Files:

- `test/unit/canonicalBody.test.ts`
- `test/unit/relayer-funding.test.ts`

If `hashCanonicalCreateBody` includes Permit2 fields, add tests proving:

- Equivalent Permit2 requests hash identically despite metadata key order.
- Different Permit2 nonce, spender, signature, or `upgradeSuperToken` changes the request hash.

If gas/funding estimation adds a representative Permit2 transaction, add a unit test proving the representative calldata selector is `runPermit2AndMacro`. Production funding uses `referenceRelayCalldata`, which prefers the larger Permit2 calldata over `runMacro`.

### 9. Implied-Upgrade Production Coverage (Required)

**Rollout decision (production):** ship `clearMacroPermit2V1` with implied-upgrade support (`upgradeSuperToken != 0x0000000000000000000000000000000000000000`). Witness-only mode remains supported for macros that do not need an on-chain token pull, but it is not sufficient alone for production readiness.

Before enabling Permit2 in production, add an implied-upgrade full stack test:

1. Deploy or reuse an ERC-20 underlying token and a wrapper SuperToken in the fixture.
2. Fund the request signer with underlying tokens and approve canonical Permit2.
3. Extend `MockPermit2.sol` with `permitWitnessTransferFrom` so the forwarder can pull underlying through Permit2.
4. Build a Permit2 witness signature with `spender = forwarderAddress` and `upgradeSuperToken = wrapperSuperToken`.
5. Submit `clearMacroPermit2V1` through the provider API.
6. Assert the transaction succeeds.
7. Assert the signer receives the upgraded SuperToken amount (or the macro `postCheck` observes `impliedUpgradeAmount`).

Do not ship implied-upgrade support based only on witness-only stack e2e plus unit tests; the token transfer and decimal conversion path is materially different.

Witness-only stack E2E remains valuable as a smaller regression test for signature validation without ERC-20 setup, but it does not replace implied-upgrade coverage.

### 10. Minimum Production Readiness Bar

For `clearMacroPermit2V1` production (including implied-upgrade), require all of the following before enabling the kind in deployed capabilities:

- Stubbed Permit2 API e2e passes.
- Full stack witness-only Permit2 e2e passes.
- Full stack implied-upgrade Permit2 e2e passes (underlying funding, Permit2 pull, SuperToken upgrade assertion).
- Contract-backed Permit2 preflight integration passes.
- API negative tests cover signature, RPC derivation, force-preflight, duplicate hiding, schema branching, and spender mode rules.
- Worker tests cover Permit2 preflight outcomes, malformed persistence, expiry, and transient submit retries.
- DB persistence test covers non-null `permit2Json`.
- Relayer funding estimates use representative `runPermit2AndMacro` calldata (larger than `runMacro`).
- Existing `clearMacroV1` tests remain unchanged and green.

## Backward Compatibility

Must remain true:

- Existing `clearMacroV1` request bodies behave exactly as before.
- Existing response fields remain stable.
- Existing DB rows with `permit2_json = null` continue to work.
- Existing tests for readiness, policy, authentication, duplicate behavior, worker lifecycle, and e2e relay pass unchanged.

## Implementation Checklist

1. Update vendored ABI sync to include `ClearMacroForwarderV1WithPermit2`.
2. Add Permit2 TypeBox schemas and request union.
3. Add Permit2 request normalization types.
4. Add witness/type-string RPC helpers.
5. Add Permit2 domain separator and digest helper.
6. Add Permit2 signature validation path with EOA + ERC-1271 support.
7. Add `buildRunPermit2AndMacroCalldata`.
8. Add `preflightRunPermit2AndMacro`.
9. Refactor create route into shared validation plus kind-specific admission.
10. Persist canonical `permit2Json`.
11. Branch worker submission by `execution.kind`.
12. Extend `/v1/capabilities` with `supportedKinds`.
13. Update fixtures and tests listed above.
14. Run `pnpm run typecheck`, `pnpm run lint`, and `pnpm run test:ci`.
15. Run `pnpm run test:e2e:stack` before shipping if Docker/Anvil/OZ are available.

## Acceptance Criteria

- `clearMacroV1` remains behaviorally unchanged.
- `clearMacroPermit2V1` can be created through `POST /v1/relay-executions`.
- Provider derives Permit2 `witness` and `witnessTypeString`; clients do not provide them.
- Invalid Permit2 signatures are rejected before persistence and cannot be bypassed by forced preflight.
- Worker submits `runPermit2AndMacro` calldata for Permit2 executions.
- Fast unit/integration/e2e tests cover API validation, dedupe, persistence, preflight, worker submission, and response behavior.
- Full stack e2e proves witness-only and implied-upgrade Permit2 relay succeed against Anvil + OZ Relayer.

## Final Review Notes

The implementation is considered deployment-ready for `clearMacroPermit2V1` with implied-upgrade support, provided the operational rollout uses `ClearMacroForwarderV1WithPermit2` on every configured chain that advertises Permit2 support.

Production notes:

- `/v1/capabilities` advertises `clearMacroPermit2V1` for every configured chain. This is acceptable for a big-bang rollout where all configured forwarders support Permit2. If chains are migrated gradually, add per-chain capability gating before exposing the kind.
- Relayer funding now uses representative `runPermit2AndMacro` calldata, but the default reference gas limit must still be validated against target-chain implied-upgrade transactions and raised or overridden if needed.
- Permit2 deadlines are enforced by preflight/onchain execution. A permit can still expire after admission and before worker submission; consider adding a worker-side `permit2.permit.deadline` expiry transition if this becomes noisy operationally.
- The implied-upgrade stack test uses an 18-decimal ERC-20 wrapper path. Decimal conversion edge cases remain covered at the protocol-contract layer rather than in this provider stack fixture.

Backward compatibility notes:

- Valid `clearMacroV1` request/response behavior remains unchanged.
- Existing DB rows with `permit2_json = null` continue to map as `clearMacroV1` rows.
- The API now rejects malformed cross-kind bodies, such as `clearMacroV1` requests carrying a `permit2` object or `clearMacroPermit2V1` requests carrying a top-level `signature`. This is an intentional schema tightening for invalid requests.
