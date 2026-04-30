# ClearMacro Provider

ClearMacro Provider is a TypeScript backend service that accepts signed ClearMacro relay executions, validates policy against a static registry, tracks execution lifecycle state in SQLite, and executes transactions through OpenZeppelin Relayer.

## What It Runs

- `app`: Fastify API + relayer worker
- `oz-relayer`: transaction backend
- `redis`: OpenZeppelin Relayer persistence

Main endpoints:

- `POST /v1/relay-executions`
- `GET /v1/relay-executions/:id`
- `GET /v1/capabilities`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`

Public relay execution states:

- `accepted`
- `pending`
- `submitted`
- `included`
- `succeeded`
- `reverted`
- `rejected`
- `failed`
- `expired`
- `canceled`

Idempotency:

- Provide `Idempotency-Key` on `POST /v1/relay-executions` to make create calls retry-safe.
- Replay with same canonical body returns the same execution resource.
- Reusing a key with a different canonical body returns `409 IDEMPOTENCY_CONFLICT`.

## Requirements

- Node.js 24+
- pnpm 10+
- Docker + Docker Compose

## Local Development

Install dependencies:

```bash
pnpm install
```

Start local relayer stack (Anvil + Redis + OZ Relayer):

```bash
pnpm run oz:bootstrap:anvil
pnpm run stack:dev
```

Run API locally:

```bash
pnpm run dev
```

Useful checks:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

## Production Deployment

### 1) Prepare environment

Create `.env` from `.env.example` and set production values, especially:

- `OZ_RELAYER_API_KEY`
- `OZ_STORAGE_ENCRYPTION_KEY`
- `OZ_WEBHOOK_SIGNING_KEY`
- `OZ_KEYSTORE_PASSPHRASE`
- `DATABASE_PATH` (default is `/data/clearmacro-provider.sqlite` in Compose)

### 2) Provide configuration files

- Create `config/registry.json` (enabled chains, relayer IDs, forwarders, macros, providers).
- Ensure OpenZeppelin Relayer config is present under `config/oz-relayer/`.
- Ensure signer keystore files are mounted under `config/oz-relayer/keys/` (do not commit keys).

### 3) Start production stack

```bash
docker compose -f compose.prod.yaml up -d --build
```

### 4) Verify health/readiness

- App:
  - `GET /healthz`
  - `GET /readyz`
- Relayer:
  - `GET /api/v1/health`
  - `GET /api/v1/ready`

### 5) Operational notes

- Keep `OZ_REPOSITORY_STORAGE_TYPE=redis`.
- Keep `OZ_RESET_STORAGE_ON_START=false`.
- Keep `OZ_STORAGE_ENCRYPTION_KEY` stable across restarts.
- Back up both persistent volumes:
  - app SQLite data
  - Redis data used by OpenZeppelin Relayer

