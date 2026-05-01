# Dashboard Transaction State Machines

> **Note:** Conceptual mapping for Dashboard UX. Align public state names with [`simplified-dapp-facing-relay-api.md`](./simplified-dapp-facing-relay-api.md) (`pending`, `submitted`, … — no `accepted` / `included` in the provider API).

This document compares the Dashboard dapp transaction state machine today with the state machine it would need when migrating transaction execution to `clearmacro-provider`.

## 1. Dashboard Today: Connected Wallet Broadcasts The Transaction

```mermaid
stateDiagram-v2
    [*] --> FormReady: user fills action form
    FormReady --> BuildingTransaction: build contract operation / batch call
    BuildingTransaction --> AwaitingWalletApproval: wallet popup opens

    AwaitingWalletApproval --> WalletRejected: user rejects / wallet error
    AwaitingWalletApproval --> WalletBroadcasting: user approves transaction

    WalletBroadcasting --> WalletBroadcastFailed: wallet/RPC rejects before tx hash
    WalletBroadcasting --> TxHashReceived: wallet returns transaction hash

    TxHashReceived --> RegisterTrackedTransaction: registerNewTransaction(hash)
    RegisterTrackedTransaction --> DashboardPending: transactionTracker status Pending

    DashboardPending --> ChainSucceeded: receipt success via tx.wait / provider.waitForTransaction
    DashboardPending --> ChainFailed: receipt failed / wait error / tracker failure

    ChainSucceeded --> MarkPendingUpdateSucceeded: pendingUpdate.hasTransactionSucceeded = true
    MarkPendingUpdateSucceeded --> WaitingForIndexedState: wait for protocol/scheduler/vesting/auto-wrap data sync
    WaitingForIndexedState --> UiSynced: subgraph/API data reflects transaction effects

    WalletRejected --> [*]
    WalletBroadcastFailed --> [*]
    ChainFailed --> [*]
    UiSynced --> [*]
```

Current Dashboard assumptions:

- The mutation succeeds only after the connected wallet returns a transaction hash.
- The transaction hash is the primary local ID for `transactionTracker` and most `pendingUpdates`.
- Once a hash exists, Dashboard can show the transaction drawer item and explorer link immediately.
- Chain success is detected by `tx.wait()` / `provider.waitForTransaction(hash)`.
- After chain success, Dashboard keeps optimistic UI state until the relevant indexed data source catches up.

## 2. Dashboard With clearmacro-provider Relay

```mermaid
stateDiagram-v2
    [*] --> FormReady: user fills action form
    FormReady --> BuildingClearMacroPayload: call macro view functions / encode params
    BuildingClearMacroPayload --> AwaitingTypedDataSignature: wallet EIP-712 signature popup opens

    AwaitingTypedDataSignature --> SignatureRejected: user rejects / wallet error
    AwaitingTypedDataSignature --> SignatureReceived: wallet returns signature

    SignatureReceived --> PostingRelayRequest: POST /v1/relay

    PostingRelayRequest --> RelayRequestRejected: provider rejects before persistence
    PostingRelayRequest --> ProviderRequestAccepted: 202 requestId + statusUrl

    ProviderRequestAccepted --> TrackProviderRequest: store requestId/clientRequestId locally
    TrackProviderRequest --> ProviderRequestPending: poll GET /v1/requests/:id

    ProviderRequestPending --> ProviderQueued: provider state accepted/queued
    ProviderQueued --> ProviderRequestPending: poll again

    ProviderRequestPending --> ProviderSubmittedNoHash: provider state pending, tx hash not available yet
    ProviderSubmittedNoHash --> ProviderRequestPending: poll again

    ProviderRequestPending --> TxHashReceived: currentTxHash / relayerTransaction.txHash exists

    TxHashReceived --> RegisterTrackedTransaction: create/update Dashboard transaction keyed by tx hash
    RegisterTrackedTransaction --> DashboardPending: transactionTracker-compatible status Pending

    DashboardPending --> ProviderStillPending: provider state pending
    ProviderStillPending --> ProviderRequestPending: poll again

    DashboardPending --> ProviderConfirmed: provider state confirmed
    DashboardPending --> ProviderReverted: provider state reverted
    DashboardPending --> ProviderFailed: provider terminal failure before/after broadcast

    ProviderConfirmed --> MarkPendingUpdateSucceeded: pendingUpdate.hasTransactionSucceeded = true
    MarkPendingUpdateSucceeded --> WaitingForIndexedState: wait for protocol/scheduler/vesting/auto-wrap data sync
    WaitingForIndexedState --> UiSynced: subgraph/API data reflects transaction effects

    SignatureRejected --> [*]
    RelayRequestRejected --> [*]
    ProviderReverted --> [*]
    ProviderFailed --> [*]
    UiSynced --> [*]
```

Additional Dashboard states introduced by provider relaying:

- `TrackProviderRequest`: Dashboard must persist a provider request before a transaction hash exists.
- `ProviderQueued`: the provider accepted the request, but the worker has not submitted it to the relayer yet.
- `ProviderSubmittedNoHash`: the relayer accepted the transaction intent, but no RPC transaction hash is available yet.
- `TxHashReceived`: the point where Dashboard can bridge into its existing hash-keyed transaction drawer and pending-update model.

Key difference:

- Today, Dashboard moves from wallet approval directly to a tx-hash-based local transaction.
- With `clearmacro-provider`, Dashboard first needs a request-ID-based tracker, then later attaches or creates the normal tx-hash-based transaction once the provider exposes a hash.
