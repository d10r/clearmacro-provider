#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_PROD_FILE:-compose.prod.yaml}"

pnpm run prod:validate
docker compose -f "$COMPOSE_FILE" up -d redis oz-relayer
pnpm run prod:verify-oz-import
pnpm run prod:apply-config -- --no-restart-app
docker compose -f "$COMPOSE_FILE" up -d --build --force-recreate app
pnpm run prod:check
