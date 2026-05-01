# Specifications

## Canonical (current product)

| Document | Role |
|----------|------|
| [`simplified-dapp-facing-relay-api.md`](./simplified-dapp-facing-relay-api.md) | **Public HTTP API**, registry minimal shape, states, worker behavior, errors |
| [`implementation-progress.md`](./implementation-progress.md) | Implementation choices and open questions |

## Operations

| Document | Role |
|----------|------|
| [`operations.md`](./operations.md) | Deploy, backup, CI, local stack |

## Historical / superseded

The following kept **design history**; where they conflict with **simplified-dapp-facing-relay-api.md**, the simplified spec wins:

- [`dapp-facing-relay-api-update.md`](./dapp-facing-relay-api-update.md) — older relay API iteration (idempotency key, `accepted` / `included`, etc.)
- [`implementation-plan.md`](./implementation-plan.md) — original milestone plan
- [`initial-provider-plan.md`](./initial-provider-plan.md), [`transaction-policy.md`](./transaction-policy.md), [`advanced-test-plan.md`](./advanced-test-plan.md) — earlier planning

## Other

- [`provider-dapp-state-machines.md`](./provider-dapp-state-machines.md) — conceptual mapping (may not match v1 API names exactly)
- [`oz-relayer-spike.md`](./oz-relayer-spike.md) — relayer spike notes
