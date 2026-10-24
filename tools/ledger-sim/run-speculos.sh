#!/usr/bin/env bash
# Start a virtual Ledger Nano X with the XRP app. Test networks only.
#   ELF=path/to/app.elf SEED_FILE=/absolute/private/path/ledger-sim.seed ./run-speculos.sh
# Without SEED_FILE, Speculos uses its public default seed (fine for CI, not for a shared demo).
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ELF="${ELF:-$SCRIPT_DIR/fixtures/xrp-2.8.2-nanox-api27.elf}"
PORT="${PORT:-5000}"
APDU_PORT="${APDU_PORT:-9999}"
ARGS=(--model nanox --display headless --api-port "$PORT" --apdu-port "$APDU_PORT")
if [[ -n "${SEED_FILE:-}" ]]; then ARGS+=(--seed "$(cat "$SEED_FILE")"); fi
if command -v speculos >/dev/null 2>&1; then
  exec speculos "${ARGS[@]}" "$ELF"
else
  # macOS / no local install: Ledger's image (not testable from the planning sandbox).
  exec docker run --rm \
    -p "127.0.0.1:$PORT:$PORT" \
    -p "127.0.0.1:$APDU_PORT:$APDU_PORT" \
    -v "$(dirname "$ELF"):/apps:ro" \
    ghcr.io/ledgerhq/speculos \
    "${ARGS[@]}" "/apps/$(basename "$ELF")"
fi
