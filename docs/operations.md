# Operations

This service normally runs as three components:

- **app:** Fastify API and relayer worker.
- **oz-relayer:** OpenZeppelin Relayer transaction backend.
- **redis:** OpenZeppelin Relayer repository storage.

The app stores relay execution state in SQLite. OpenZeppelin Relayer stores transaction backend state in Redis. Back up both.

## Runtime Topology

```mermaid
flowchart LR
    App["Provider app<br/>HTTP API + worker"]
    SQLite[("SQLite<br/>execution / audit / events")]
    OZ["OpenZeppelin Relayer"]
    Redis[("Redis<br/>relayer repository")]
    App --> SQLite
    App -->|submit + poll| OZ
    OZ --> Redis
```

## Local Development

```bash
pnpm install
pnpm run oz:bootstrap:anvil
pnpm run stack:dev
pnpm run dev
```

The app reads `.env`. Required variables include `DATABASE_PATH`, `OZ_RELAYER_URL`, `OZ_RELAYER_API_KEY`, and `PROVIDER_NAME`. If API auth is enabled, set `API_AUTH_ENABLED=true` and `API_CLIENTS_JSON`.

Useful checks:

```bash
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run build
```

The Docker stack E2E is intentionally opt-in:

```bash
pnpm run test:e2e:stack
```

It requires Docker, Docker Compose v2, Foundry, and local Anvil/OZ relayer fixture setup.

## Production Deployment

1. Create production `.env` from `.env.example`.
2. Set `OZ_RELAYER_API_KEY`, `PROVIDER_NAME`, relayer and Redis secrets, and `DATABASE_PATH`.
3. Set `OZ_RELAYER_UID` and `OZ_RELAYER_GID` to the numeric owner of `config/oz-relayer/keys/*`; `pnpm run prod:init` fills these when missing on POSIX systems.
4. Provide `config/provider.json` from a checked-in example or generated Superfluid template, then set production RPC URLs and `macroPolicy`.
5. Provide OpenZeppelin Relayer config and keystores under `config/oz-relayer/`.
6. Run `pnpm run oz:gen:networks` after the provider registry is final, and optionally `pnpm run oz:gen:networks -- --update-config`.
7. Start with `docker compose -f compose.prod.yaml up -d --build` or `pnpm run stack:prod`.

At startup, the app queries OpenZeppelin Relayer and binds exactly one active relayer per configured `chainId`. Missing or ambiguous relayer matches fail startup by design.

## Relayer signer gas

The OpenZeppelin Relayer signer must hold native gas on every chain in `config/provider.json`.

- **Check balances:** `pnpm run prod:validate` (prints per-chain balance).
- **Top up:** `pnpm run prod:fund` — per-chain `fundingTxCount` from **30d Superfluid `flowUpdatedEvents`** (subgraph), scaled vs the median chain (`FUNDING_BASE_TX_COUNT`, default `30`). Provider SQLite relay history overrides subgraph when present. Use `SIMULATE=1` first. Flat mode: `TARGET_TX_COUNT=30`. Filters: `CHAIN_IDS`, `TESTNET_ONLY=1`, `MAINNET_ONLY=1`.
- **Metrics:** on `GET /metrics`, sampled every `RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS` (default 60 minutes; `0` disables):
  - `clearmacro_relayer_signer_balance_native{chain_id}` — latest native-token balance
  - `clearmacro_relayer_signer_balance_probe_success{chain_id}` — `1` if the last sample succeeded
  - `clearmacro_relayer_signer_balance_last_update_timestamp_seconds{chain_id}` — last successful sample time (alert if stale)
- **Alerting:** Gate low-balance alerts on `clearmacro_relayer_signer_balance_probe_success == 1` so a failed RPC/OZ sample is not mistaken for an empty wallet. Treat data as stale when `time() - clearmacro_relayer_signer_balance_last_update_timestamp_seconds` exceeds roughly two sample intervals (default ~2 hours at the 60-minute interval). Readiness and relay traffic still catch zero balance on admission; these metrics are for coarse monitoring between samples.

## Verification

After deployment:

```bash
curl -fsS https://clearmacro-provider.superfluid.dev/healthz
curl -fsS https://clearmacro-provider.superfluid.dev/readyz
curl -fsS https://clearmacro-provider.superfluid.dev/v1/capabilities
```

For a full smoke test, submit a controlled `POST /v1/relay-executions` on a test chain and poll the returned execution until it is terminal.

## Data And Backups

- Back up the app SQLite database. It contains relay executions, audit rows, lifecycle events, and app-side relayer snapshots.
- Back up Redis. It contains OpenZeppelin Relayer transaction backend state.
- Do not run multiple app workers against the same SQLite file. The current deployment model is one app instance per SQLite database.

## Readiness Runbook

`GET /healthz` only confirms the process is running. `GET /readyz` is stricter: it checks configured chains, app RPCs, relayer binding, OpenZeppelin Relayer readiness, and signer balance.

If `readyz` returns `503`:

- `PROVIDER_NOT_READY` usually means local provider dependencies are not ready, such as signer balance or app RPC access.
- `RELAYER_UNAVAILABLE` means the relayer is down, paused, misconfigured, unreachable, or returned an unexpected failure.
- `RELAYER_RATE_LIMITED` means OpenZeppelin Relayer returned HTTP 429 after bounded retries.

Short rate-limit bursts are operationally different from a hard relayer outage. Check OpenZeppelin Relayer logs and metrics before changing provider config. In production, keep relayer HTTP access private, use finite rate limits, and size those limits from observed provider readiness and worker traffic.
