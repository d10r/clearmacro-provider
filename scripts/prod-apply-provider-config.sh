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

Flow:
  1. Regenerate OZ bootstrap files (prod:init)
  2. Ensure redis + oz-relayer are running
  3. Verify live OZ import (prod:verify-oz-import) — fails before app starts
  4. Apply API-safe drift (prod:apply-config)
  5. Start/restart app

If OZ import verification fails, the script may offer a guarded OZ Redis re-import.
Use --reimport-oz to skip the first non-destructive attempt and re-import immediately.
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

wait_for_oz_relayer() {
  echo "== Wait for OZ Relayer to finish boot/import =="
  sleep 8
}

run_oz_gate_and_apply() {
  echo "== Verify live OZ import matches provider.json =="
  pnpm run prod:verify-oz-import

  echo "== Apply API-safe config drift (no app restart yet) =="
  pnpm run prod:apply-config -- --no-restart-app

  echo "== Start app =="
  docker compose -f "$COMPOSE_FILE" up -d --build app
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
  wait_for_oz_relayer

  run_oz_gate_and_apply
}

reimport_required_from_log() {
  grep -Eq "bootstrap_required|system-disabled|OZ import mismatch" "$1"
}

if [[ "$FORCE_REIMPORT" == true ]]; then
  run_reimport
else
  echo "== Generate OZ bootstrap files from provider.json =="
  pnpm run prod:init

  echo "== Ensure Redis and OZ Relayer are running =="
  docker compose -f "$COMPOSE_FILE" up -d redis oz-relayer
  wait_for_oz_relayer

  gate_log="$(mktemp)"
  if run_oz_gate_and_apply >"$gate_log" 2>&1; then
    cat "$gate_log"
    rm -f "$gate_log"
  elif reimport_required_from_log "$gate_log"; then
    cat "$gate_log"
    rm -f "$gate_log"
    echo "OZ import verification or apply failed; a Redis re-import may be required."
    run_reimport
  else
    cat "$gate_log"
    rm -f "$gate_log"
    exit 1
  fi
fi

echo "== Compose status =="
docker compose -f "$COMPOSE_FILE" ps

echo "Done. Verify /healthz, /readyz, and /v1/capabilities on the configured host port."
