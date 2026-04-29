# OpenZeppelin Relayer Spike

This spike evaluates OpenZeppelin Relayer (`v1.4.0`) as the ClearMacro transaction backend using a local Anvil + Redis + Docker Compose stack.

## Scope

- Validate burst nonce behavior and multiple in-flight submissions.
- Validate status API richness and lifecycle mapping.
- Validate revert visibility.
- Validate restart recovery behavior with Redis persistence.
- Validate multi-RPC failover behavior.
- Validate replacement/cancel endpoint behavior.
- Validate health and metrics endpoint usefulness.

## Docker Image Availability

The OpenZeppelin relayer repository includes Docker docs with Docker Hub images.

- Preferred image: `openzeppelin/openzeppelin-relayer:v1.4.0`
- If that tag is unavailable locally, fallback to local build from checked-out source:
  - edit `spikes/oz-relayer/compose.yaml`
  - uncomment:
    - `build.context: ../../openzeppelin-relayer`
    - `build.dockerfile: Dockerfile.production`
  - then run `docker compose -f spikes/oz-relayer/compose.yaml up -d --build`

## Prerequisites

- Docker + Docker Compose plugin.
- Node 24+ and project dependencies installed.
- `cast` available (Foundry), used only to generate a local test keystore.

## File-First Configuration

Relayer setup is file-based:

- `spikes/oz-relayer/config/config.json`
- `spikes/oz-relayer/config/networks/evm.json`
- generated local keystore:
  - `spikes/oz-relayer/config/keys/anvil-relayer.json`

No runtime relayer creation APIs are used for baseline setup.

## Inferred Rules Used In This Spike

These are explicit assumptions added to make pass/fail concrete.

### Nonce Validity Rules

A burst is considered nonce-valid when all accepted transactions satisfy:

1. No duplicate nonce across accepted txs, except valid replacement semantics.
2. No nonce gap larger than 1 unless an intermediate nonce is terminal failed/canceled/expired.
3. Duplicate nonce is valid only when one transaction with that nonce is terminal non-success and another supersedes it.

### Lifecycle Mapping Expectation

OpenZeppelin statuses (from `openapi.json`) map to ClearMacro lifecycle as:

- `pending`, `sent`, `submitted` -> `pending`
- `mined`, `confirmed` -> `confirmed`
- `failed` with revert-like reason (`revert`, `execution reverted`) -> `reverted`
- `failed` without revert signature -> `dropped/failed`
- `canceled`, `expired` -> `dropped/failed`
- submission HTTP failure (`4xx/5xx`) -> `submit_failed`

### Pending Transaction Strategy On Anvil

Not a blocker. To better exercise pending behavior:

- Anvil runs with `--block-time 2`.
- Tests submit bursts without waiting for confirmations.
- Restart/replace/cancel scenarios run immediately after submission.

This does not guarantee long pending queues, but is sufficient to test intent (concurrent submission and post-restart recoverability) on local dev infrastructure.

### RPC Failover Threshold

Failover is considered adequate if each trial (20 submissions) has:

- `>= 95%` successful submission when one RPC endpoint is dead and one is healthy.

Rationale:

- local single-node setup should show near-perfect fallback;
- allowing one transient miss (19/20) avoids false negatives from startup races.

## Runbook

From repository root:

1) Generate keystore file (test-only key):

```bash
npx tsx spikes/oz-relayer/scripts/bootstrap-keystore.ts
```

2) Start stack:

```bash
docker compose -f spikes/oz-relayer/compose.yaml up -d

# IMPORTANT: fund the relayer signer on local Anvil
cast send --rpc-url http://localhost:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  0xa9f9add7e644c15ea3596f8653c69d66ff708dc7 \
  --value 100ether
```

3) Wait for readiness:

```bash
npx tsx spikes/oz-relayer/scripts/wait-ready.ts
```

4) Scenario 1: Burst submission:

```bash
npx tsx spikes/oz-relayer/scripts/submit-burst.ts
```

5) Scenario 2: Revert handling:

```bash
npx tsx spikes/oz-relayer/scripts/submit-revert.ts
```

6) Scenario 3: Restart recovery:

```bash
npx tsx spikes/oz-relayer/scripts/restart-and-recover.ts
```

7) Scenario 4: RPC failover:

```bash
npx tsx spikes/oz-relayer/scripts/test-rpc-failover.ts
```

8) Scenario 5: Replacement/cancel:

```bash
npx tsx spikes/oz-relayer/scripts/replacement-cancel.ts
```

9) Scenario 6: Metrics and health:

```bash
npx tsx spikes/oz-relayer/scripts/metrics-health.ts
```

10) Stop stack:

```bash
docker compose -f spikes/oz-relayer/compose.yaml down -v
```

## Output Artifacts

Scripts write scenario evidence to:

- `spikes/oz-relayer/results/*.json`

Use:

- `spikes/oz-relayer/results/conclusion.md`

to summarize viability and required spec changes based on observed evidence.
