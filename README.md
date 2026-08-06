# ClearMacro Provider

TypeScript service that accepts signed **ClearMacro relay executions**, validates policy against static **provider config**, tracks lifecycle in **SQLite**, and submits transactions via **OpenZeppelin Relayer**. Provider config holds chain policy (forwarders, allowed macros, RPCs); relayer IDs are resolved at startup from the relayer API.

**Production:** https://clearmacro-provider.superfluid.dev  
**API reference:** https://clearmacro-provider.superfluid.dev/docs  
**Operations:** [`docs/operations.md`](docs/operations.md)  
**Architecture notes:** [`docs/architecture.md`](docs/architecture.md)  
**Implementation specs:** [`specs/`](specs/)

## What it runs

- **app:** Fastify HTTP API + relayer worker (same process)
- **oz-relayer:** transaction backend
- **redis:** OpenZeppelin Relayer repository storage

## HTTP API (v1)

Swagger at `/docs` is the API reference for request/response shapes, status codes, field descriptions, and examples.

| Method   | Path                       | Purpose                                                            |
| -------- | -------------------------- | ------------------------------------------------------------------ |
| `GET`    | `/healthz`                 | Liveness                                                           |
| `GET`    | `/readyz`                  | Readiness (per-chain: RPC, relayer, signer balance)                |
| `GET`    | `/metrics`                 | Prometheus metrics                                                 |
| `GET`    | `/v1/capabilities`         | Global `providerName` + per-chain `forwarderAddress` + `macroPolicy` |
| `POST`   | `/v1/relay-executions`     | Create execution (sync validate + preflight; worker submits later) |
| `GET`    | `/v1/relay-executions/:id` | Execution resource; `?include=events` for lifecycle events         |
| `DELETE` | `/v1/relay-executions/:id` | Cancel before relayer submission (`awaiting_authorization` / pre-submit `pending`) |

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

### Safe message authorization (optional)

When `SAFE_API_KEY` is set, `clearMacroV1` may use Safe off-chain message signing instead of a top-level EIP-1271/`signature` field. Set `SAFE_AUTHORIZATION_ENABLED=false` to force the feature off while keeping the key configured.

- Request: exactly one of `signature` **or** `authorization: { type: "safeMessageV1", safeMessageHash }` (mutually exclusive).
- Response starts in `awaiting_authorization` until a background authorization worker sees ERC-1271 validation of the ClearMacro digest (prepared Safe signature and/or on-chain-approved empty signature), then promotes to `pending` for normal relayer submission.
- `DELETE /v1/relay-executions/:id` cancels an `awaiting_authorization` (or pre-submit `pending`) execution so the dapp can abandon a long-lived Safe intent; idempotent if already `canceled`.
- `GET /v1/capabilities` includes per-chain `supportedAuthorizationMethods` (always `signature`; also `safeMessageV1` when Safe auth is enabled and the chain is supported by the Safe Transaction Service).
- Not supported with `clearMacroPermit2V1`, and not compatible with `forceExecuteAfterPreflightRevert`.
- Env: `SAFE_API_KEY` (enables the feature), optional `SAFE_AUTHORIZATION_ENABLED` kill switch, poll/retry knobs, optional `SAFE_TX_SERVICE_URL` — see `.env.example`.

## Requirements

- Node.js 24+
- pnpm 11+
- Docker + Docker Compose (for local stack / prod compose)

## Configuration

### Environment (see `.env.example`)

| Variable               | Required   | Notes                                                                                           |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_PATH`        | no         | Local/non-Compose SQLite path; production Compose always uses `/data/clearmacro-provider.sqlite` |
| `OZ_RELAYER_URL`       | app only   | In-container relayer URL; `compose.prod.yaml` defaults to `http://oz-relayer:8080`              |
| `OZ_RELAYER_ADMIN_URL` | no         | Advanced override for admin job; default in `admin` service is `http://oz-relayer:8080`           |
| `OZ_RELAYER_API_KEY`   | yes        | Relayer API bearer                                                                              |
| `PROVIDER_CONFIG_PATH` | no         | Default `config/provider.json`                                                                  |
| `PROVIDER_NAME`        | yes        | Must match `payload.security.provider` from dapps (also returned by `GET /v1/capabilities`)     |
| `API_AUTH_ENABLED`     | no         | Default `false`                                                                                 |
| `API_CLIENTS_JSON`     | if auth on | JSON array `[{ "id", "apiTokenHash" }]` where `apiTokenHash` is SHA-256 hex of the bearer token |
| `SAFE_API_KEY`         | no         | Safe Transaction Service API key. When set, enables `safeMessageV1` for `clearMacroV1`. Must be listed in `compose.prod.yaml` so the app container receives it. |
| `SAFE_AUTHORIZATION_ENABLED` | no   | Optional override. Omit to derive from `SAFE_API_KEY`. `false` forces off; `true` requires key. |

### Provider Config JSON (`config/provider.json`)

Minimal v1 shape:

- `version`: `1`
- `chains[]`: `chainId`, `forwarderAddress`, **`rpcUrls`** (non-empty array of at least one URL), and `macroPolicy`.
- `macroPolicy.mode = "allowlist"` requires `allowedMacros[]` with `{ domain, address }`; `macroPolicy.mode = "open"` accepts any macro on that chain. RPCs are used for digest reads, signature checks, preflight, and readiness.

Only chains present in `chains[]` are supported; leave chains you do not relay out of the file.

**Minimal starter:** `config/provider.example.json` — copy to `config/provider.json` and replace placeholder RPCs/addresses before `pnpm run prod:init` or first run.

You can generate Superfluid-wide templates from `@superfluid-finance/metadata` with `pnpm run provider:gen:superfluid`. For production traffic, review generated chains, set `macroPolicy`, and replace public `rpcUrls` with your own RPC provider URLs.

## Forwarder ABI

On-chain calls use a **vendored** `ClearMacroForwarderV1WithPermit2` ABI at `src/chain/clearMacroForwarderV1.abi.ts` (no runtime dependency on `@superfluid-finance/ethereum-contracts`). After the forwarder changes in protocol-monorepo, regenerate from a local build:

```bash
# in protocol-monorepo/packages/ethereum-contracts: yarn build
PROTOCOL_MONOREPO=../protocol-monorepo pnpm run abi:sync:clear-macro-forwarder
```

When `ethereum-contracts` publishes a release that includes ClearMacro, you can switch to `import … from "@superfluid-finance/ethereum-contracts/build/bundled-abi.json"` instead of vendoring.

## Local development

```bash
pnpm install
pnpm run dev:oz-bootstrap
pnpm run stack:dev
```

`dev:oz-bootstrap` copies `config/provider.anvil.json` and `config/oz-relayer/config.example.json` when missing, creates the Anvil keystore, and generates gitignored `config/oz-relayer/networks/evm.json` for the Docker OZ relayer.

Run the API (needs `.env` with at least `OZ_*`, `PROVIDER_NAME`, and a valid `config/provider.json`; `DATABASE_PATH` defaults to `./data/clearmacro-provider-dev.sqlite` for local runs):

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

Production config touches three separate state planes:

1. **Bootstrap files** — `config/oz-relayer/*` generated by `prod:init` for first boot import.
2. **Live OZ state** — Redis-backed networks/relayers owned by OpenZeppelin Relayer after first boot.
3. **App runtime** — the provider app container reads `config/provider.json` and talks to OZ at `http://oz-relayer:8080`.

The normal admin path is `prod:init`, `prod:up`, and `prod:check`. Lower-level commands (`prod:verify-oz-import`, `prod:apply-config`, `prod:check-config`) remain available for troubleshooting and are run by the wrappers as needed. Live OZ admin jobs run as a Compose `admin` one-off on the internal network at `http://oz-relayer:8080` (no host OZ port publish).

1. **`.env`** from `.env.example` — set `PROVIDER_NAME`, and if using auth, `API_CLIENTS_JSON`. `pnpm run prod:init` fills generated relayer/redis secrets and `OZ_RELAYER_UID` / `OZ_RELAYER_GID` when missing. Do not set `DATABASE_PATH` for production Compose.
2. **`config/provider.json`** — start from `config/provider.example.json` or generate a Superfluid-wide template with `pnpm run provider:gen:superfluid`, then set `rpcUrls` and `macroPolicy` for your deployment.
3. **Bootstrap:** `pnpm run prod:init` — secrets, keystore, and `config/oz-relayer/*` bootstrap files (see `config/oz-relayer/README.md`). Top up signer gas with **`pnpm run prod:fund`** (`SIMULATE=1` first).
4. **Validate and start:** `pnpm run prod:up` — validates files/secrets/funding, starts Redis and OZ Relayer, verifies/imports live OZ state, starts the app, and runs production checks.
5. **Day-2 changes:** edit `provider.json`, then run **`pnpm run prod:up`** again. The command is idempotent and applies live OZ config before starting/restarting the app.
6. **Verify anytime:** `pnpm run prod:check` — validates local config and signer funding, checks live OZ state, and hits `GET /healthz`, `GET /readyz`, and `GET /v1/capabilities`.

Advanced troubleshooting commands:

- `pnpm run prod:validate` — local files/secrets/bootstrap/funding validation. Use `VERBOSE=1` to print every chain balance.
- `pnpm run prod:verify-oz-import` — verify first-boot OZ import before app startup.
- `pnpm run prod:apply-config` — reconcile live Redis-backed OZ state with `provider.json`.
- `pnpm run prod:check-config` — check live OZ drift without changing state.
- `pnpm run stack:prod:logs` — follow production Compose logs.

See [docs/operations.md](docs/operations.md) for the full config lifecycle and readiness runbook.

Operational notes: keep Redis persistence for the relayer; back up **both** app SQLite and Redis volumes; run **one** app instance per SQLite file (single worker design). See [`docs/operations.md`](docs/operations.md) for the deployment checklist and readiness runbook.
