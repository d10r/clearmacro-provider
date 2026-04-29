# ClearMacro Provider Backend: Operations

## Runtime Model

Production runs three local services with Docker Compose from this repository:

- `app`: ClearMacro Provider API and relayer worker.
- `oz-relayer`: OpenZeppelin Relayer transaction backend.
- `redis`: OpenZeppelin Relayer repository storage.

The ClearMacro Provider app stores its own state in SQLite on a mounted data volume. OpenZeppelin Relayer stores its transaction backend state in Redis. Prometheus and Grafana are assumed to be external infrastructure and are not bundled.

## Local Development

Start local dependencies:

```bash
pnpm run oz:bootstrap:anvil
pnpm run stack:dev
```

Run the app directly on the host for fast reload/debugging:

```bash
pnpm run dev
```

The app reads `DATABASE_PATH`, `OZ_RELAYER_URL`, `OZ_RELAYER_API_KEY`, and `REGISTRY_PATH` from `.env` or the shell. Use `.env.example` as the template.

For local end-to-end development, Compose includes Anvil and an OpenZeppelin Relayer config wired to Anvil. `pnpm run oz:bootstrap:anvil` creates the local test keystore expected by `config/oz-relayer/config.json`. Fund the configured local relayer signer before submitting transactions.

## CI

CI should run Node directly and use temporary SQLite files for app integration tests. Unit tests should not require Docker.

Typical flow:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
```

End-to-end tests that require Anvil + OpenZeppelin Relayer + Redis should run in a separate job or manual workflow because they require Docker and multiple services.

## Production

Create a production `.env` file from `.env.example`, set real values, provide `config/registry.json`, provide OpenZeppelin Relayer signer config under `config/oz-relayer/`, then run:

```bash
docker compose -f compose.prod.yaml up -d --build
```

Production requirements:

- Set a strong `OZ_RELAYER_API_KEY`.
- Set a stable high-entropy `OZ_STORAGE_ENCRYPTION_KEY`; do not rotate it casually because OpenZeppelin Relayer uses it for stored repository data.
- Set `OZ_RESET_STORAGE_ON_START=false`.
- Keep `OZ_REPOSITORY_STORAGE_TYPE=redis`.
- Keep OpenZeppelin Relayer signer keys out of git.
- Ensure the relayer signer has native gas token on every enabled chain.
- Provide `config/registry.json`; the example file is intentionally disabled.
- Back up the app SQLite volume and Redis volume.
- Configure external Prometheus to scrape the app `/metrics` endpoint and the OpenZeppelin Relayer metrics endpoint.
- Monitor app readiness via `/readyz` and liveness via `/healthz`.
- Monitor OpenZeppelin Relayer readiness via `/api/v1/ready` and liveness via `/api/v1/health`.

The production Compose stack is intentionally self-contained for this service: app, OpenZeppelin Relayer, and Redis. Do not expect an external database service.

Run exactly one `app` container in v1. SQLite is the app state store and the relayer worker is designed for one active app process. Do not horizontally scale the app or run multiple worker processes against the same SQLite database until an explicit distributed claiming mechanism is added.

## Data And Backups

Persistent volumes:

- `app-data`: SQLite database and related app files.
- `oz-redis-data`: Redis append-only persistence for OpenZeppelin Relayer repository state.

Backup both volumes. SQLite contains client-facing request/audit state; Redis contains OpenZeppelin Relayer transaction backend state.

## Deployment Checklist

- Confirm AGPL-3.0 licensing for OpenZeppelin Relayer is acceptable for the deployment.
- Create a dedicated Linux user for the service with Docker access.
- Place production `.env` with mode `0600`.
- Place `config/registry.json` with enabled chains and relayer IDs.
- Place OpenZeppelin Relayer config and signer keystore under `config/oz-relayer/`.
- Start Compose.
- Verify `app` `/readyz` is healthy.
- Verify OpenZeppelin Relayer `/api/v1/ready` is healthy.
- Verify Prometheus can scrape both metrics endpoints.
- Submit a small smoke-test transaction on an explicitly selected chain only after confirming signer funding.
