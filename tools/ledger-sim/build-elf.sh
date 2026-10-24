#!/usr/bin/env bash
# Build Ledger's XRP device app (Nano X) for Speculos. Linux or any Ubuntu 24.04 container.
# Verified 2026-10-21: app-xrp 2.8.2 + ledger-secure-sdk v27.1.2 (API level 27) + speculos 0.27.1.
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
OUT="${1:-$SCRIPT_DIR/build}"
WORK="$(mktemp -d)"
git clone --depth 1 https://github.com/LedgerHQ/app-xrp "$WORK/app-xrp"
git clone --depth 1 -b v27.1.2 https://github.com/LedgerHQ/ledger-secure-sdk "$WORK/sdk"
# The SDK's final .apdu packaging step needs ledgerblue; app.elf is complete before it, so ignore that failure.
make -C "$WORK/app-xrp" -j8 BOLOS_SDK="$WORK/sdk" TARGET=nanox || true
mkdir -p "$OUT"
cp "$WORK/app-xrp/build/nanox/bin/app.elf" "$OUT/xrp-nanox.elf"
echo "built $OUT/xrp-nanox.elf"
