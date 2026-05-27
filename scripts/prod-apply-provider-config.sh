#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="${COMPOSE_FILE:-compose.prod.yaml}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
OZ_REDIS_VOLUME="${OZ_REDIS_VOLUME:-${PROJECT_NAME}_oz-redis-data}"
ASSUME_YES=false
FORCE_REIMPORT=false

for arg in "$@"; do
  case "$arg" in
    -y|--yes)
      ASSUME_YES=true
      ;;
    --reimport-oz)
      FORCE_REIMPORT=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/prod-apply-provider-config.sh [--yes] [--reimport-oz]

Apply config/provider.json changes on the production machine.

The normal path runs the API-safe apply without wiping Redis. If OZ reports
bootstrap_required for a new network, the script asks before wiping only the
OpenZeppelin Relayer Redis volume and re-importing the generated bootstrap
files. Use --reimport-oz to skip the first non-destructive attempt.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

confirm_reimport() {
  echo "This will remove Docker volume: ${OZ_REDIS_VOLUME}"
  echo "That wipes OpenZeppelin Relayer Redis state (queue/counters/live config), but not the app database."
  if [[ "$ASSUME_YES" != true ]]; then
    read -r -p "Continue? Type 'yes' to proceed: " answer
    if [[ "$answer" != "yes" ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
}

run_reimport() {
  confirm_reimport

  echo "== Generate OZ bootstrap files from provider.json =="
  pnpm run prod:init

  echo "== Stop current prod stack =="
  docker compose -f "$COMPOSE_FILE" down --remove-orphans

  echo "== Remove OZ Redis volume =="
  docker volume rm "$OZ_REDIS_VOLUME" 2>/dev/null || true

  echo "== Start Redis and OZ Relayer for config import =="
  docker compose -f "$COMPOSE_FILE" up -d redis oz-relayer

  echo "== Check live OZ state against provider.json =="
  pnpm run prod:check-config

  echo "== Apply API-safe config drift without restarting app yet =="
  pnpm run prod:apply-config -- --no-restart-app

  echo "== Start app =="
  docker compose -f "$COMPOSE_FILE" up -d --build app
}

if [[ "$FORCE_REIMPORT" == true ]]; then
  run_reimport
else
  echo "== Generate OZ bootstrap files from provider.json =="
  pnpm run prod:init

  echo "== Ensure Redis and OZ Relayer are running =="
  docker compose -f "$COMPOSE_FILE" up -d redis oz-relayer

  echo "== Apply API-safe config changes =="
  apply_log="$(mktemp)"
  if pnpm run prod:apply-config |& tee "$apply_log"; then
    rm -f "$apply_log"
  elif grep -q "bootstrap_required" "$apply_log"; then
    rm -f "$apply_log"
    echo "OZ reported bootstrap_required. A Redis re-import is required for this provider.json change."
    run_reimport
  else
    rm -f "$apply_log"
    exit 1
  fi
fi

echo "== Compose status =="
docker compose -f "$COMPOSE_FILE" ps

echo "Done. Verify /healthz, /readyz, and /v1/capabilities on the configured host port."
