#!/usr/bin/env bash
set -euo pipefail

provider_port="${CLEARMACRO_PROVIDER_HOST_PORT:-}"
if [[ -z "$provider_port" && -f .env ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" == "CLEARMACRO_PROVIDER_HOST_PORT" ]] || continue
    provider_port="${value%$'\r'}"
    provider_port="${provider_port%\"}"
    provider_port="${provider_port#\"}"
    break
  done < .env
fi
provider_port="${provider_port:-3000}"

pnpm run prod:validate
pnpm run prod:check-config
curl -fsS "http://localhost:${provider_port}/healthz" >/dev/null
curl -fsS "http://localhost:${provider_port}/readyz" >/dev/null
curl -fsS "http://localhost:${provider_port}/v1/capabilities" >/dev/null
echo "Production stack check passed."
