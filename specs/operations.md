# ClearMacro Provider Backend: Operations

Canonical product behavior: [`simplified-dapp-facing-relay-api.md`](./simplified-dapp-facing-relay-api.md).

## Runtime model

Production typically runs three services via Docker Compose from this repository:

- **app:** ClearMacro Provider API + relayer worker.
- **oz-relayer:** OpenZeppelin Relayer transaction backend.
- **redis:** OpenZeppelin Relayer repository storage.

The app stores relay execution state in **SQLite** on a mounted data volume. The relayer stores transaction backend state in **Redis**. Prometheus/Grafana are external.

## Local development

```bash
pnpm run oz:bootstrap:anvil
pnpm run stack:dev
```

Run the app on the host (fast reload):

```bash
pnpm run dev
```

The app reads `.env` (see `.env.example`). Required variables include `DATABASE_PATH`, `OZ_RELAYER_URL`, `OZ_RELAYER_API_KEY`, and **`PROVIDER_NAME`**. If `API_AUTH_ENABLED=true`, set **`API_CLIENTS_JSON`**.

`pnpm run oz:bootstrap:anvil` prepares the local keystore expected by `config/oz-relayer/config.json`. Fund the local relayer signer before submitting.

## CI

Typical pipeline:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run build
```

Unit and integration tests use temporary SQLite databases and mocked relayer/RPC where appropriate. **E2E** tests (`pnpm run test:e2e`) run full HTTP journeys in-process (Fastify `inject`) with the same patterns—no Docker required for CI.

Contract-backed **preflight** integration tests (`test/integration/preflight-anvil.test.ts`) spawn **Anvil** and require the `anvil` binary on `PATH` (e.g. [Foundry](https://book.getfoundry.sh/getting-started/installation)).

**Docker stack E2E** (`pnpm run test:e2e:stack`) brings up **Redis, Anvil, OpenZeppelin Relayer, and the provider app** via [compose.e2e.yaml](compose.e2e.yaml), deploys the `RelayerLikePreflightForwarder` fixture on Anvil (not production ClearMacro), and asserts HTTP smoke through to `succeeded`. Requires **Docker**, **Docker Compose v2**, **pnpm**, **Foundry** (`forge` for the fixture artifact, `cast` optional for keystore bootstrap), and a one-time **`pnpm run oz:bootstrap:anvil`** if `config/oz-relayer/keys/anvil-relayer.json` is missing. The script sets `RUN_STACK_E2E=1` automatically.

## Production

1. Create production `.env` from `.env.example` (`0600`). Set at least:
   - `OZ_RELAYER_API_KEY`
   - `PROVIDER_NAME` (must match dapp `payload.security.provider`)
   - Relayer/redis secrets (`OZ_STORAGE_ENCRYPTION_KEY`, etc.)
   - `DATABASE_PATH` (default under `/data` in Compose)
   - If auth: `API_AUTH_ENABLED=true` and `API_CLIENTS_JSON`
2. Provide **`config/registry.json`** using the **minimal** schema: `chains[].chainId`, `forwarderAddress`, non-empty **`rpcUrls`**, `allowedMacros[]` (`domain` + `address`).
3. Provide OpenZeppelin Relayer config and keystores under **`config/oz-relayer/`** (keys not in git).
4. Ensure **exactly one** active relayer per configured chain is discoverable via the relayer API at app startup.
5. `docker compose -f compose.prod.yaml up -d --build`
6. Verify **`GET /readyz`**, relayer **`GET /api/v1/ready`**, then smoke **`GET /v1/capabilities`** and a controlled **`POST /v1/relay-executions`**.

Self-contained stack: app + relayer + Redis. Do not horizontally scale multiple app workers against the same SQLite file.

## Data and backups

- **app-data:** SQLite (`relay_executions`, audit log, events, internal relayer snapshots).
- **oz-redis-data:** Relayer repository state.

Back up **both**. Loss of Redis loses relayer-side transaction metadata; loss of SQLite loses app-side execution history.

## Deployment checklist

- AGPL-3.0 acceptable for OpenZeppelin Relayer in your environment.
- Dedicated service user with Docker access where applicable.
- Production `.env` and `config/registry.json` permissions locked down.
- `PROVIDER_NAME` aligned with dapps and `GET /v1/capabilities`.
- Relayer signer funded on every chain in `registry.json`.
- External Prometheus scraping **`/metrics`** (and relayer metrics if used).
- Liveness **`/healthz`**, readiness **`/readyz`** wired into orchestration.
