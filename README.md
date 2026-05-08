# ClearMacro Provider

TypeScript service that accepts signed **ClearMacro relay executions**, validates policy against static **provider config**, tracks lifecycle in **SQLite**, and submits transactions via **OpenZeppelin Relayer**. Provider config holds chain policy (forwarders, allowed macros, RPCs); relayer IDs are resolved at startup from the relayer API.

**Canonical API spec:** [`specs/simplified-dapp-facing-relay-api.md`](specs/simplified-dapp-facing-relay-api.md)  
**Spec index:** [`specs/README.md`](specs/README.md)

## What it runs

- **app:** Fastify HTTP API + relayer worker (same process)
- **oz-relayer:** transaction backend
- **redis:** OpenZeppelin Relayer repository storage

## HTTP API (v1)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness (per-chain: RPC, relayer, signer balance) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/v1/capabilities` | Global `providerName` + per-chain `forwarderAddress` |
| `POST` | `/v1/relay-executions` | Create execution (sync validate + preflight; worker submits later) |
| `GET` | `/v1/relay-executions/:id` | Execution resource; `?include=events` for lifecycle events |

### Public execution states

`pending`, `submitted`, `succeeded`, `reverted`, `rejected`, `failed`, `expired`, `canceled`

New executions start in **`pending`**. After a transaction hash is known, the state is **`submitted`** until a terminal outcome. Full semantics are in the spec linked above.

### Dedup and retries

- The dedupe key is `(chainId, forwarderAddress, signerAddress, digest)` where `digest` is the forwarder’s `getDigest(macro, payload)`. Repeating `POST /v1/relay-executions` with the same intent returns the same execution.
- Same intent + same authenticated `client_id` → **`200`** with the existing execution.
- Same intent + different `client_id` (auth on) → **`409 DUPLICATE_EXECUTION`** without leaking the other execution id.
- With auth off, everyone is `anonymous` → same digest always replays as **`200`**.

### Force after preflight revert

Optional `forceExecuteAfterPreflightRevert: true` creates a **`pending`** execution after a **deterministic** preflight revert (for intentional on-chain attempts). Policy, signature, expiry, readiness, and malformed-payload checks still run as usual; this flag only changes how a deterministic preflight revert is handled.

## Requirements

- Node.js 24+
- pnpm 10+
- Docker + Docker Compose (for local stack / prod compose)

## Configuration

### Environment (see `.env.example`)

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_PATH` | yes | SQLite file path |
| `OZ_RELAYER_URL` | yes | OpenZeppelin Relayer base URL |
| `OZ_RELAYER_API_KEY` | yes | Relayer API bearer |
| `PROVIDER_CONFIG_PATH` | no | Default `config/provider.json` |
| `PROVIDER_NAME` | yes | Must match `payload.security.provider` from dapps (also returned by `GET /v1/capabilities`) |
| `API_AUTH_ENABLED` | no | Default `false` |
| `API_CLIENTS_JSON` | if auth on | JSON array `[{ "id", "apiTokenHash" }]` where `apiTokenHash` is SHA-256 hex of the bearer token |

### Provider Config JSON (`config/provider.json`)

Minimal v1 shape:

- `version`: `1`
- `chains[]`: `chainId`, `forwarderAddress`, **`rpcUrls`** (non-empty array of at least one URL), and `macroPolicy`.
- `macroPolicy.mode = "allowlist"` requires `allowedMacros[]` with `{ domain, address }`; `macroPolicy.mode = "open"` accepts any macro on that chain. RPCs are used for digest reads, signature checks, preflight, and readiness.

Only chains present in `chains[]` are supported; leave chains you do not relay out of the file.

**Superfluid-wide templates** (from `@superfluid-finance/metadata`: MacroForwarder per chain, `publicRPCs` as `rpcUrls`, empty `allowedMacros`):

- `config/provider.superfluid-mainnets.json` — mainnets only (typical production starting point).
- `config/provider.superfluid-all.json` — mainnets + testnets.

Regenerate after a metadata upgrade: `pnpm run provider:gen:superfluid` and `pnpm run provider:gen:superfluid -- --out config/provider.superfluid-mainnets.json --mainnet-only`. For production traffic, replace `rpcUrls` with your own RPC provider URLs.

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

1. **`.env`** from `.env.example` — set `OZ_RELAYER_API_KEY`, `PROVIDER_NAME`, relayer/redis secrets, `DATABASE_PATH`, and if using auth, `API_CLIENTS_JSON`.
2. **`config/provider.json`** — copy or derive from `config/provider.superfluid-mainnets.json` (or `provider.superfluid-all.json`), then set `rpcUrls` and `macroPolicy` for your deployment.
3. **OpenZeppelin Relayer** — under `config/oz-relayer/` (see `config/oz-relayer/README.md`). After the registry is final, run **`pnpm run oz:gen:networks`** (and optionally **`-- --update-config`**) so `networks/evm.json` (and relayer entries) match Superfluid-backed chains. Signers and keystores stay manual; fund signers with native gas on every chain.
4. **Startup** — the app **binds** exactly one active relayer per registry `chainId` by querying the relayer API; misconfiguration causes startup failure (by design).
5. **Compose:** `docker compose -f compose.prod.yaml up -d --build`
6. **Verify:** `GET /healthz`, `GET /readyz`, relayer `/api/v1/ready`, smoke `GET /v1/capabilities` + `POST /v1/relay-executions` on a test chain.

Operational notes: keep Redis persistence for the relayer; back up **both** app SQLite and Redis volumes; run **one** app instance per SQLite file (single worker design).

Further detail: [`specs/operations.md`](specs/operations.md).
