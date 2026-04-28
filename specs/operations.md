# ClearMacro Provider Backend: Operations

## Runtime Model

Production should run the app and PostgreSQL with Docker Compose from this repository. Prometheus and Grafana are assumed to be external infrastructure and are not bundled.

Local development and CI should normally run the application process on the host with `npm`, while PostgreSQL runs in Docker.

## Local Development

Start the database:

```bash
npm run db:up
```

Run the app directly on the host for fast reload/debugging:

```bash
npm run dev
```

The app reads `DATABASE_URL` from `.env` or the shell. Use `.env.example` as the template.

## CI

CI should run Node directly and provide PostgreSQL either through Docker Compose or Testcontainers.

Typical flow:

```bash
npm ci
npm run db:up
npm run db:migrate
npm run test
npm run typecheck
npm run build
npm run db:down
```

Database integration tests may use Testcontainers for isolated databases. Unit tests should not require Docker.

## Production

Create a production `.env` file from `.env.example`, set real values, then run:

```bash
docker compose -f compose.prod.yaml up -d --build
```

Production requirements:

- Set a strong `POSTGRES_PASSWORD`.
- Set a real `RELAYER_PRIVATE_KEY`. Never use the placeholder key from `.env.example`.
- Provide `config/registry.json`; the example file is intentionally disabled.
- Keep the PostgreSQL Docker volume backed up.
- Configure external Prometheus to scrape `http://<host>:<port>/metrics`.
- Monitor readiness via `/readyz` and liveness via `/healthz`.

The production Compose stack is intentionally simple: one app container plus one local Postgres container. Do not expect an external Postgres service.
