# Spec: Proposed Relay Simulation Endpoint (No Signature)

## Status

**Proposed** — not implemented. This document captures design findings from provider API review (June 2026).

## Problem

Dapps need to know whether a ClearMacro action is likely to succeed **before** asking the user to sign an EIP-712 digest (or Permit2 witness transfer). Today the provider only simulates during `POST /v1/relay-executions`, which:

1. Requires a valid signature.
2. Persists a relay execution on success (or on forced preflight override).
3. Returns only a coarse `PREFLIGHT_REVERTED` error without structured revert data.

That makes create unsuitable as a dry-run / preview API.

## Goal

Add a **read-only simulation endpoint** that accepts an unsigned ClearMacro payload and returns whether the relayed macro effects are predicted to succeed at simulation time.

Primary UX:

```text
Build payload → POST simulate (no signature) → show user outcome → user signs → POST relay-executions
```

## Non-Goals

- Do not replace or weaken `POST /v1/relay-executions` admission checks.
- Do not persist executions, deduplicate, or enqueue worker submission from simulation.
- Do not accept or validate signatures on this endpoint (by design).
- Do not guarantee eventual onchain success; simulation is best-effort at request time.
- Do not expose internal relayer IDs, raw OZ payloads, or full RPC traces in v1.
- v1 does not need to fully simulate Permit2 implied-upgrade flows (see [Permit2 limitations](#permit2-limitations)).

## Current State (Findings)

### What exists today

| Mechanism | Signature required? | Persists execution? | Purpose |
|-----------|--------------------|--------------------|---------|
| `POST /v1/relay-executions` preflight | Yes | Yes (on pass or force) | Admission gate before queueing |
| Worker preflight before submit | Yes (from stored row) | N/A | Safety re-check before broadcast |
| `forceExecuteAfterPreflightRevert` | Yes | Yes | Override predicted revert at create |
| `GET /readyz` | N/A | No | Provider/relayer/RPC readiness only |

Create-time preflight calls `runMacro(...)` via `simulateContract`, with:

- `account` = configured relayer signer
- `value` = request `value`

See `src/chain/readiness.ts` (`preflightRunMacro`).

### Why create cannot serve as dry-run

`ClearMacroForwarderV1.runMacro` validates the signature **before** macro execution:

```solidity
if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) {
    revert InvalidSignature();
}
_validatePayload(m, payload, signer, msg.sender);
return _executeValidatedMacro(m, payload, signer);
```

Without a valid signature, the existing preflight path cannot reach macro effects. There is no forwarder `simulate` / `preview` function in protocol contracts today.

### What dapps can do without provider changes

A dapp can simulate locally against public RPC:

1. `GET /v1/capabilities` for `forwarderAddress` and `providerName`.
2. Build unsigned `payload`.
3. `eth_call` `macro.buildBatchOperations(host, action.params, signer)`.
4. Simulate Host batch execution with relayer/forwarder as executor and signer as forwarded user (EIP-2771 append pattern).

The provider endpoint would centralize policy checks, relayer modeling, and consistent error shaping — not introduce a capability that is impossible client-side.

## What Simulation Can Answer

### In scope (useful pre-sign)

- Payload decodes correctly.
- Request `macroAddress` matches `payload.security.macroContract`.
- Provider name matches deployment (`payload.security.provider`).
- Validity window (`validAfter` / `validBefore`) is currently satisfied.
- Macro admission policy (`allowlist` / `open`) allows the macro.
- Configured chain is known to the provider.
- **Macro execution effects** are predicted to succeed:
  - `buildBatchOperations` succeeds.
  - Host `forwardBatchCall` path succeeds for the signer as forwarded sender.
  - Macro `postCheck` succeeds when it is view-safe for the action.

### Out of scope (explicit non-guarantees)

- Signature validity (user has not signed yet).
- ClearMacro nonce consumption / sequencing at execution time.
- Permit2 witness signature and token pull (unless extended later).
- State drift between simulate and actual relay (balances, pool units, deadlines).
- Relayer gas funding, OZ availability, or submission timing.
- Full byte-for-byte equivalence with `runMacro` / `runPermit2AndMacro` without a protocol simulate helper.

## Recommended API

### Endpoint

```http
POST /v1/relay-simulations
```

Read-only. Idempotent from the dapp perspective. No side effects.

### Request (`clearMacroV1`)

```json
{
  "kind": "clearMacroV1",
  "chainId": 11155420,
  "macroAddress": "0x1111111111111111111111111111111111111111",
  "signerAddress": "0x2222222222222222222222222222222222222222",
  "payload": "0x...",
  "value": "0"
}
```

Field rules:

- **No** top-level `signature`.
- **No** `forceExecuteAfterPreflightRevert`.
- **No** `clientRequestId` / `metadata` required in v1 (optional correlation fields may be added later).
- `value` defaults to `"0"` when omitted.
- Reject requests that include `signature` with `400 VALIDATION_ERROR` and a clear message.

Future: extend with `kind: "clearMacroPermit2V1"` and unsigned `permit2` permit fields only (see [Permit2 limitations](#permit2-limitations)).

### Response (success prediction)

```json
{
  "kind": "clearMacroV1",
  "chainId": 11155420,
  "macroAddress": "0x1111111111111111111111111111111111111111",
  "signerAddress": "0x2222222222222222222222222222222222222222",
  "forwarderAddress": "0x3333333333333333333333333333333333333333",
  "simulated": true,
  "success": true,
  "checks": {
    "payloadValid": true,
    "macroPolicyAllowed": true,
    "providerAllowed": true,
    "validityWindowOk": true,
    "macroExecution": "ok"
  }
}
```

### Response (predicted revert)

```json
{
  "kind": "clearMacroV1",
  "chainId": 11155420,
  "macroAddress": "0x1111111111111111111111111111111111111111",
  "signerAddress": "0x2222222222222222222222222222222222222222",
  "forwarderAddress": "0x3333333333333333333333333333333333333333",
  "simulated": true,
  "success": false,
  "checks": {
    "payloadValid": true,
    "macroPolicyAllowed": true,
    "providerAllowed": true,
    "validityWindowOk": true,
    "macroExecution": "revert"
  },
  "error": {
    "code": "SIMULATION_REVERTED",
    "message": "Macro execution is predicted to revert.",
    "category": "user",
    "retryable": true,
    "details": {
      "revertData": "0x..."
    }
  }
}
```

### Response (failed before simulation)

When policy or payload validation fails, return `success: false`, `simulated: false`, and an appropriate error code. Do not run macro simulation if upstream checks already failed.

Example early failure:

```json
{
  "simulated": false,
  "success": false,
  "checks": {
    "payloadValid": false,
    "macroPolicyAllowed": false,
    "providerAllowed": false,
    "validityWindowOk": false,
    "macroExecution": "skipped"
  },
  "error": {
    "code": "INVALID_CLEAR_MACRO_PAYLOAD",
    "message": "Decoded macro contract does not match request macroAddress.",
    "category": "validation",
    "retryable": false,
    "details": {}
  }
}
```

### HTTP status codes

| Status | When |
|--------|------|
| `200` | Simulation completed (whether or not `success` is true) |
| `400` | Malformed request (including forbidden `signature` field) |
| `401` | Auth required and missing/invalid bearer |
| `403` | Chain not configured, macro not allowed, provider mismatch |
| `422` | Payload decode failure, expired / not-yet-valid window |
| `503` | RPC unavailable for required simulation reads |

Unlike create, a predicted macro revert should be **`200`** with `success: false`, not `422`. The endpoint's job is to report simulation outcome, not reject admission.

### Capabilities discovery

Extend `GET /v1/capabilities` (optional v1 addition):

```json
{
  "chainId": 11155420,
  "forwarderAddress": "0x...",
  "supportedKinds": ["clearMacroV1"],
  "supportedSimulationKinds": ["clearMacroV1"]
}
```

## Implementation Options

### Option A — Provider macro simulation (recommended v1)

No protocol contract change. Provider simulates macro effects directly:

1. Decode payload (`decodeClearMacroPayload`).
2. Run shared policy checks (mirror create route steps 1–5, minus digest/signature).
3. Resolve relayer signer from OZ (same as create preflight).
4. `eth_call` `IClearMacro.buildBatchOperations(host, action.params, signerAddress)`.
5. Simulate Host batch execution equivalent to forwarder `_forwardBatchCallWithSenderAndValue`:
   - operations from step 4
   - executor = relayer signer (or forwarder, per fidelity testing)
   - forwarded user = `signerAddress` via EIP-2771 calldata append
   - `value` = request `value`
6. If macro exposes view `postCheck`, invoke it when safe for the action.

**Pros:** shippable without protocol upgrade; matches dapp pre-sign UX needs.  
**Cons:** must carefully mirror forwarder Host call semantics; macro-specific `postCheck` edge cases; incomplete for Permit2 implied upgrade.

### Option B — Forwarder view function (recommended long-term)

Add to `ClearMacroForwarderV1` / `ClearMacroForwarderV1WithPermit2`:

```solidity
function simulateMacro(
    IClearMacro m,
    bytes calldata encodedPayload,
    address signer
) external view returns (bool success);
```

Skips signature and nonce persistence; runs payload validation (except nonce update) and macro execution via `staticcall` where possible. Provider calls this view over RPC.

**Pros:** canonical semantics; one implementation for dapps and provider.  
**Cons:** requires protocol change, deployment, ABI sync, and upgrade coordination.

### Option C — Dapp-only (status quo)

Document local simulation pattern; no provider endpoint.

**Pros:** zero provider work.  
**Cons:** duplicated logic across dapps; no centralized policy surfacing; inconsistent relayer modeling.

### Recommendation

Ship **Option A** in clearmacro-provider first. Track **Option B** as a protocol follow-up if fidelity gaps appear in production.

## Simulation Algorithm (Option A detail)

### Shared validation (no signature)

Reuse create-route helpers where possible:

| Check | On failure |
|-------|------------|
| Request schema | `400 VALIDATION_ERROR` |
| Chain in registry | `403 CHAIN_NOT_ALLOWED` |
| Decode payload | `422 INVALID_CLEAR_MACRO_PAYLOAD` |
| `macroAddress` == decoded macro | `422 INVALID_CLEAR_MACRO_PAYLOAD` |
| `provider` == deployment `providerName` | `403 PROVIDER_NOT_ALLOWED` |
| Validity window | `422 CLEAR_MACRO_EXPIRED` / `CLEAR_MACRO_NOT_YET_VALID` |
| Macro policy | `403 MACRO_NOT_ALLOWED` |

Skip:

- `getForwarderDigest`
- `validateRelaySignature`
- deduplication
- persistence
- worker enqueue

Readiness: v1 may skip full `GET /readyz`-style relayer balance checks and only require RPC availability for simulation. Document that `503` means "could not simulate now," not "relay permanently unavailable."

### Macro execution simulation

Add `simulateClearMacroExecution` in `src/chain/readiness.ts` (or `src/chain/simulation.ts`):

```ts
export type SimulateClearMacroInput = {
  chain: RegistryChain;
  forwarder: string;
  host: string;
  macro: string;
  encodedPayload: string;
  signer: string;
  relayerSigner: string;
  msgValue: string;
};

export type SimulateClearMacroResult =
  | { status: "ok" }
  | { status: "revert"; revertData?: string }
  | { status: "rpc_unavailable" };
```

Implementation notes:

- Resolve `host` from forwarder (`host()` getter on `ForwarderBase`) or cache from registry if added later.
- Decode `action.params` from payload for `buildBatchOperations`.
- Use `withRpcFallback` like existing readiness helpers.
- Capture revert data from simulation errors when the RPC provides it.
- Classify only clear execution reverts as `revert`; network failures as `rpc_unavailable`.

### Fidelity checklist

Before shipping, verify against `test/e2e/relay-stack.e2e.test.ts` fixtures that Option A agrees with real `runMacro` outcomes for:

- happy path
- insufficient balance / flow failure
- invalid action params
- wrong provider role (should be caught before macro sim via policy, not macro revert)

Document any known divergences in this file.

## Permit2 Limitations

Unsigned simulation for `clearMacroPermit2V1` is **partial** at best.

| Mode | Unsigned simulate feasibility |
|------|------------------------------|
| Witness-only (`upgradeSuperToken = 0`) | Macro half may be simulable; Permit2 authorization not validated |
| Implied upgrade | **Not reliable** without Permit2 signature and pull; `postCheck` (e.g. `Permit2Upgrade`) reads `impliedUpgradeAmount` set only during `_pullAndUpgrade` in the same transaction |

v1 recommendation:

- Ship simulation for `clearMacroV1` only.
- Defer `clearMacroPermit2V1` simulation or return `501 NOT_IMPLEMENTED` / `success: false` with `SIMULATION_UNSUPPORTED` until Option B or a dedicated Permit2 simulation design exists.

See also: `specs/run-permit2-and-macro-support.md`.

## Security and Abuse

- **No authentication bypass:** simulation must not weaken create-route policy semantics for fields it validates.
- **No signature oracle:** endpoint must not leak whether a digest would be valid; it does not accept signatures.
- **Rate limiting:** apply stricter limits than create if the endpoint is public (RPC cost per request).
- **No persistence:** do not write `relay_executions` or audit rows that could be confused with real executions. Optional lightweight metrics counters are fine.
- **Macro policy:** still enforce allowlist in simulate; do not expose simulation for disallowed macros.

## Dapp Integration Guide

```mermaid
sequenceDiagram
    participant Dapp
    participant Provider as ClearMacro Provider
    participant Wallet
    Dapp->>Provider: GET /v1/capabilities
    Provider-->>Dapp: forwarderAddress, providerName, macroPolicy
    Note over Dapp: Build unsigned payload
    Dapp->>Provider: POST /v1/relay-simulations
    Provider-->>Dapp: success true/false, checks, optional revertData
    alt success true
        Dapp->>Wallet: Request EIP-712 signature
        Wallet-->>Dapp: signature
        Dapp->>Provider: POST /v1/relay-executions
        Provider-->>Dapp: 202 execution id
    else success false
        Note over Dapp: Show error; do not prompt signature
    end
```

Interpretation rules for dapps:

- `success: true` → safe to prompt signature (still not a guarantee).
- `success: false` + `macroExecution: revert` → fix user inputs/state before signing.
- `simulated: false` → policy/payload problem; fix request before re-simulating.
- Always follow simulate with `POST /v1/relay-executions` for actual relay; never treat simulate as submission.

## Relationship to Existing Preflight

| | Create preflight | Proposed simulate |
|--|------------------|-------------------|
| Signature | Required | Forbidden |
| Persists row | Yes | No |
| Simulates | `runMacro` end-to-end | Macro effects (Option A) or `simulateMacro` view (Option B) |
| Predicted revert HTTP | `422 PREFLIGHT_REVERTED` | `200` + `success: false` |
| Use case | Relay admission | Pre-sign UX |

Keep both. Simulate is not a substitute for create-time preflight after the user signs.

## Test Plan

Follow existing Vitest patterns (`test/unit`, `test/integration`, `test/e2e`, optional `test/e2e:stack`).

### Unit tests

New file: `test/unit/simulation.test.ts`

- Rejects request containing `signature`.
- Normalizes/default `value`.
- Maps validation failures to correct error codes without calling RPC.
- Encodes/decodes Host forward simulation helper calldata (if extracted).
- Classifies revert vs RPC failure correctly.

Extend `test/unit/builder.test.ts` only if simulation shares calldata helpers.

### Integration tests

New file: `test/integration/simulation-api.test.ts` (or extend `api.test.ts`)

Using `createTestHarness` with injectable `simulateClearMacroExecution`:

- Returns `200` + `success: true` when simulation passes.
- Returns `200` + `success: false` + `SIMULATION_REVERTED` on macro revert.
- Returns `403` for macro policy / provider mismatch (no macro sim run).
- Returns `422` for invalid payload / validity window.
- Returns `503` when RPC unavailable.
- Does **not** create `relay_executions` rows.
- Does **not** appear in dedup / replay behavior.

Contract-backed: extend `test/integration/preflight-anvil.test.ts` or add `simulation-anvil.test.ts` comparing Option A simulation vs `runMacro` with valid signature on fixture forwarder/macro.

### E2E

`test/e2e/relay-api.e2e.test.ts`:

- `POST /v1/relay-simulations` happy path stubbed.
- Journey: simulate success → create with signature → worker → terminal success.

`test/e2e/relay-stack.e2e.test.ts` (optional, `RUN_STACK_E2E=1`):

- Full stack: simulate unsigned payload → expect `success: true` → signed create → poll succeeded.

### Regression

Existing create, worker, and preflight tests must remain unchanged.

## Implementation Checklist

1. Add `CreateRelaySimulationRequestSchema` and response schemas in `src/api/schemas.ts`.
2. Add `POST /v1/relay-simulations` route in `src/api/routes.ts`.
3. Extract shared unsigned validation from create route into reusable helpers.
4. Implement `simulateClearMacroExecution` (Option A).
5. Wire route handler; no DB writes.
6. Optionally extend `/v1/capabilities` with `supportedSimulationKinds`.
7. Add unit + integration tests listed above.
8. Document endpoint in Swagger `/docs` and README API table.
9. Run `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:ci`.

## Acceptance Criteria

- Dapp can `POST /v1/relay-simulations` with unsigned `clearMacroV1` payload.
- Endpoint returns structured pass/fail without creating executions.
- Predicted macro revert returns `200` with `success: false` and optional `revertData`.
- Create route behavior for signed relay is unchanged.
- Tests cover validation, simulation outcomes, and no-persistence invariant.

## Open Questions

1. Should simulate require the same API auth as create when `API_AUTH_ENABLED=true`? **Recommendation:** yes, same bearer auth.
2. Should simulate call OZ for relayer signer on every request? **Recommendation:** yes for executor fidelity; cache relayer address briefly if needed.
3. Should revert reasons be decoded to ClearMacro / Superfluid error names in v1? **Recommendation:** optional `details.revertData` only in v1; decoding in v2.
4. When should protocol `simulateMacro` (Option B) be prioritized? **Trigger:** fidelity mismatches in dashboard Permit2 or complex macros.

## References

- Current preflight: `src/chain/readiness.ts` (`preflightRunMacro`)
- Create flow: `src/api/routes.ts`, `docs/architecture.md`
- Forwarder execution: `ClearMacroForwarderV1.sol`, `ForwarderBase.sol`
- Permit2 relay spec: `specs/run-permit2-and-macro-support.md`
