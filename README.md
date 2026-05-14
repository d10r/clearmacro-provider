# ClearMacro Provider

TypeScript service that accepts signed **ClearMacro relay executions**, validates policy against static **provider config**, tracks lifecycle in **SQLite**, and submits transactions via **OpenZeppelin Relayer**. Provider config holds chain policy (forwarders, allowed macros, RPCs); relayer IDs are resolved at startup from the relayer API.

**Production:** https://clearmacro-provider.superfluid.dev  
**API reference:** https://clearmacro-provider.superfluid.dev/docs  
**Operations:** [`docs/operations.md`](docs/operations.md)  
**Architecture notes:** [`docs/architecture.md`](docs/architecture.md)

## What it runs

- **app:** Fastify HTTP API + relayer worker (same process)
- **oz-relayer:** transaction backend
- **redis:** OpenZeppelin Relayer repository storage

## HTTP API (v1)

Swagger at `/docs` is the API reference for request/response shapes, status codes, field descriptions, and examples.

| Method | Path                       | Purpose                                                            |
| ------ | -------------------------- | ------------------------------------------------------------------ |
| `GET`  | `/healthz`                 | Liveness                                                           |
| `GET`  | `/readyz`                  | Readiness (per-chain: RPC, relayer, signer balance)                |
| `GET`  | `/metrics`                 | Prometheus metrics                                                 |
| `GET`  | `/v1/capabilities`         | Global `providerName` + per-chain `forwarderAddress` + `macroPolicy` |
| `POST` | `/v1/relay-executions`     | Create execution (sync validate + preflight; worker submits later) |
| `GET`  | `/v1/relay-executions/:id` | Execution resource; `?include=events` for lifecycle events         |

### Dapp flow (typical)

```mermaid
sequenceDiagram
    participant Dapp
    participant Provider as ClearMacro Provider
    Note over Provider: HTTP API and relayer worker share one process
    Dapp->>Provider: GET /v1/capabilities
    Provider-->>Dapp: providerName, chain forwarders, macroPolicy
    Note over Dapp: Build ClearMacro payload and sign digest
    Dapp->>Provider: POST /v1/relay-executions
    Provider-->>Dapp: 202 + execution id (or 200 replay)
    loop Until execution.terminal
        Dapp->>Provider: GET /v1/relay-executions/{id}
        Provider-->>Dapp: state, optional transaction, receipt, error
    end
    Note over Provider: Worker submits to OpenZeppelin Relayer and polls in the background
```

Execution states, deduplication, status codes, errors, and request fields (including `forceExecuteAfterPreflightRevert`) are covered in the [API reference](https://clearmacro-provider.superfluid.dev/docs). For a state machine and dedup invariants, see [`docs/architecture.md`](docs/architecture.md).

## Requirements

- Node.js 24+
- pnpm 10+
- Docker + Docker Compose (for local stack / prod compose)

## Configuration

### Environment (see `.env.example`)

| Variable               | Required   | Notes                                                                                           |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_PATH`        | yes        | SQLite file path                                                                                |
| `OZ_RELAYER_URL`       | yes        | OpenZeppelin Relayer base URL                                                                   |
| `OZ_RELAYER_API_KEY`   | yes        | Relayer API bearer                                                                              |
| `PROVIDER_CONFIG_PATH` | no         | Default `config/provider.json`                                                                  |
| `PROVIDER_NAME`        | yes        | Must match `payload.security.provider` from dapps (also returned by `GET /v1/capabilities`)     |
| `API_AUTH_ENABLED`     | no         | Default `false`                                                                                 |
| `API_CLIENTS_JSON`     | if auth on | JSON array `[{ "id", "apiTokenHash" }]` where `apiTokenHash` is SHA-256 hex of the bearer token |

### Provider Config JSON (`config/provider.json`)

Minimal v1 shape:

- `version`: `1`
- `chains[]`: `chainId`, `forwarderAddress`, **`rpcUrls`** (non-empty array of at least one URL), and `macroPolicy`.
- `macroPolicy.mode = "allowlist"` requires `allowedMacros[]` with `{ domain, address }`; `macroPolicy.mode = "open"` accepts any macro on that chain. RPCs are used for digest reads, signature checks, preflight, and readiness.

Only chains present in `chains[]` are supported; leave chains you do not relay out of the file.

**Minimal starter:** `config/provider.example.json` — copy to `config/provider.json` and replace placeholder RPCs/addresses before `pnpm run prod:init` or first run.

You can generate Superfluid-wide templates from `@superfluid-finance/metadata` with `pnpm run provider:gen:superfluid`. For production traffic, review generated chains, set `macroPolicy`, and replace public `rpcUrls` with your own RPC provider URLs.

## Local development

```bash
pnpm install
pnpm run oz:bootstrap:anvil
pnpm run stack:dev
```

Run the API (needs `.env` with at least `DATABASE_PATH`, `OZ_*`, `PROVIDER_NAME`, and a valid `config/provider.json`):

```bash
pnpm run dev
```

Checks:

```bash
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run test:coverage
pnpm run build
```

## Production deployment

1. **`.env`** from `.env.example` — set `OZ_RELAYER_API_KEY`, `PROVIDER_NAME`, relayer/redis secrets, `DATABASE_PATH`, **`OZ_RELAYER_UID` / `OZ_RELAYER_GID`** (same as `id -u` / `id -g` for the user that owns `config/oz-relayer/keys/*`; required for `compose.prod.yaml`; on POSIX, `pnpm run prod:init` fills these when missing), and if using auth, `API_CLIENTS_JSON`.
2. **`config/provider.json`** — start from `config/provider.example.json` or generate a Superfluid-wide template with `pnpm run provider:gen:superfluid`, then set `rpcUrls` and `macroPolicy` for your deployment.
3. **OpenZeppelin Relayer** — under `config/oz-relayer/` (see `config/oz-relayer/README.md`). After the registry is final, run **`pnpm run oz:gen:networks`** (and optionally **`-- --update-config`**) so `networks/evm.json` (and relayer entries) match Superfluid-backed chains. Signers and keystores stay manual; fund signers with native gas on every chain.
4. **Startup** — the app **binds** exactly one active relayer per registry `chainId` by querying the relayer API; misconfiguration causes startup failure (by design).
5. **Compose:** `docker compose -f compose.prod.yaml up -d --build`. The app always listens on **port 3000 inside the container**; set **`CLEARMACRO_PROVIDER_HOST_PORT`** in `.env` to choose the **host** port mapped to it (default `3000`; see `compose.prod.yaml`).
6. **Verify:** `GET /healthz`, `GET /readyz`, relayer `/api/v1/ready`, smoke `GET /v1/capabilities` + `POST /v1/relay-executions` on a test chain.

Operational notes: keep Redis persistence for the relayer; back up **both** app SQLite and Redis volumes; run **one** app instance per SQLite file (single worker design). See [`docs/operations.md`](docs/operations.md) for the deployment checklist and readiness runbook.
