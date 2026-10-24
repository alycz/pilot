#!/bin/sh
set -eu

# MO1 local stack launcher. It never sources env files. Every child receives a
# small allowlisted environment, while framework dotenv/dev-var files are a hard
# preflight refusal. Existing listeners are never stopped or replaced.

fail() {
  printf '%s\n' "[ap4m-local] $1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

reject_profile_file() {
  path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    fail "refusing profile file $path; use a credential-free mock checkout"
  fi
}

require_port() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*) fail "$name must be a numeric port" ;;
  esac
  [ "$value" -ge 1024 ] && [ "$value" -le 65535 ] || fail "$name is outside the allowed port range"
}

require_free_port() {
  host="$1"
  port="$2"
  label="$3"
  if "$LSOF_BIN" -nP -iTCP@"$host":"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "$label refuses occupied fixed endpoint $host:$port; no process was stopped"
  fi
}

require_repo_file() {
  repo="$1"
  file="$2"
  label="$3"
  [ -d "$repo" ] || fail "$label repository is unavailable"
  [ -f "$repo/$file" ] || fail "$label repository is missing $file"
}

MM_LOOP_MODE=${AP4M_DEMO_MM_LOOP_MODE:-off}
[ "${AP4M_DEMO_ALLOW_LOCAL:-}" = "1" ] || fail "AP4M_DEMO_ALLOW_LOCAL=1 is required"
[ "${EXEC_NETWORK:-}" = "testnet" ] || fail "EXEC_NETWORK=testnet is required"
[ "${HARBOR_MOCK:-}" = "1" ] || fail "HARBOR_MOCK=1 is required"
[ "${MASTERCARD_OF_MODE:-}" = "mock" ] || fail "MASTERCARD_OF_MODE=mock is required"
case "$MM_LOOP_MODE" in
  off)
    [ "${LIVE:-0}" != "1" ] || fail "LIVE=1 is not accepted when mm-loop is off"
    ;;
  testnet)
    [ "${LIVE:-0}" = "1" ] || fail "LIVE=1 is required for the Testnet mm-loop"
    [ "${AP4M_DEMO_EVENT_LIVE_APPROVED:-}" = "1" ] || \
      fail "AP4M_DEMO_EVENT_LIVE_APPROVED=1 is required for the Testnet mm-loop"
    ;;
  *) fail "AP4M_DEMO_MM_LOOP_MODE must be off or testnet" ;;
esac
[ -z "${AP4M_DEMO_STATE_ROOT:-}" ] || fail "caller-selected state roots are not accepted"

for command_name in lsof pnpm uv node mktemp; do
  require_command "$command_name"
done
[ -x /usr/bin/env ] || fail "/usr/bin/env is required"
[ -x /usr/bin/perl ] || fail "/usr/bin/perl is required for isolated process groups"
[ -x /bin/kill ] || fail "/bin/kill is required"
[ -x /bin/sleep ] || fail "/bin/sleep is required"

LSOF_BIN=$(command -v lsof)
PNPM_BIN=$(command -v pnpm)
UV_BIN=$(command -v uv)
NODE_BIN=$(command -v node)
MKTEMP_BIN=$(command -v mktemp)
SAFE_PATH=$(dirname -- "$PNPM_BIN"):$(dirname -- "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin

PILOT_REPO=${PILOT_REPO:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)}
HARBOR_REPO=${HARBOR_REPO:-}
[ -n "$HARBOR_REPO" ] || fail "HARBOR_REPO must name the reviewed Harbor checkout"
PILOT_REPO=$(CDPATH= cd -- "$PILOT_REPO" && pwd -P)
HARBOR_REPO=$(CDPATH= cd -- "$HARBOR_REPO" && pwd -P)

require_repo_file "$PILOT_REPO" "apps/web/package.json" "Pilot"
require_repo_file "$PILOT_REPO" "services/ap4m-merchants/pyproject.toml" "merchant"
require_repo_file "$HARBOR_REPO" "wrangler.ap4m-demo.jsonc" "Harbor"
require_repo_file "$HARBOR_REPO" "migrations/0010_ap4m_channel_purchase.sql" "Harbor"

# Next and Wrangler automatically load these files. Refuse them instead of
# trusting an incomplete secret-name denylist.
for path in \
  "$PILOT_REPO/apps/web/.env" \
  "$PILOT_REPO/apps/web/.env.local" \
  "$PILOT_REPO/apps/web/.env.development" \
  "$PILOT_REPO/apps/web/.env.development.local" \
  "$PILOT_REPO/services/ap4m-merchants/.env" \
  "$PILOT_REPO/services/ap4m-merchants/.env.local" \
  "$HARBOR_REPO/.dev.vars" \
  "$HARBOR_REPO/.env" \
  "$HARBOR_REPO/.env.local"
do
  reject_profile_file "$path"
done

PILOT_HOST=127.0.0.1
PILOT_PORT=${AP4M_DEMO_PILOT_PORT:-3003}
HARBOR_HOST=127.0.0.1
HARBOR_PORT=${AP4M_DEMO_HARBOR_PORT:-8791}
MERCHANT_HOST=127.0.0.1
MERCHANT_PORT=${AP4M_DEMO_MERCHANT_PORT:-8000}

require_port AP4M_DEMO_PILOT_PORT "$PILOT_PORT"
require_port AP4M_DEMO_HARBOR_PORT "$HARBOR_PORT"
require_port AP4M_DEMO_MERCHANT_PORT "$MERCHANT_PORT"
[ "$PILOT_PORT" = "3003" ] || fail "Pilot runtime authority is fixed to 127.0.0.1:3003"
[ "$HARBOR_PORT" = "8791" ] || fail "Pilot local-wallet Harbor authority is fixed to 127.0.0.1:8791"
[ "$MERCHANT_PORT" = "8000" ] || fail "merchant demo authority is fixed to 127.0.0.1:8000"
require_free_port "$PILOT_HOST" "$PILOT_PORT" "Pilot"
require_free_port "$HARBOR_HOST" "$HARBOR_PORT" "Harbor"
require_free_port "$MERCHANT_HOST" "$MERCHANT_PORT" "merchant"

# /tmp is a symlink on macOS. Create beneath its canonical, non-symlink parent
# so a caller cannot redirect writes with .. segments or a symlink ancestor.
TMP_PARENT=/private/tmp
[ -d "$TMP_PARENT" ] && [ ! -L "$TMP_PARENT" ] || fail "canonical temporary parent is unavailable"
REAL_TMP_PARENT=$(CDPATH= cd -- "$TMP_PARENT" && pwd -P)
[ "$REAL_TMP_PARENT" = "$TMP_PARENT" ] || fail "canonical temporary parent changed"
umask 077
STATE_ROOT=$("$MKTEMP_BIN" -d "$TMP_PARENT/ap4m-demo.XXXXXX") || fail "could not create state root"
REAL_STATE_ROOT=$(CDPATH= cd -- "$STATE_ROOT" && pwd -P)
case "$REAL_STATE_ROOT" in
  "$TMP_PARENT"/ap4m-demo.*) ;;
  *) fail "generated state root escaped the canonical parent" ;;
esac
[ "$REAL_STATE_ROOT" = "$STATE_ROOT" ] || fail "generated state root is not canonical"
mkdir -m 700 "$STATE_ROOT/logs" "$STATE_ROOT/harbor" "$STATE_ROOT/home" "$STATE_ROOT/tmp"

pids=""
cleanup() {
  trap - EXIT HUP INT TERM
  for pid in $pids; do
    # Every child is a new session/process-group leader. Terminate the entire
    # group so package-manager and server descendants cannot retain a port.
    /bin/kill -TERM "-$pid" >/dev/null 2>&1 || true
  done
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    groups_alive=0
    for pid in $pids; do
      if /bin/kill -0 "-$pid" >/dev/null 2>&1; then
        groups_alive=1
      fi
    done
    [ "$groups_alive" -eq 1 ] || break
    attempts=$((attempts + 1))
    /bin/sleep 0.1
  done
  for pid in $pids; do
    /bin/kill -KILL "-$pid" >/dev/null 2>&1 || true
  done
  for pid in $pids; do
    wait "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT HUP INT TERM

start_process() {
  label="$1"
  shift
  /usr/bin/perl -MPOSIX=setsid -e 'setsid() >= 0 or die "setsid failed"; exec @ARGV or die "exec failed"' -- \
    "$@" >"$STATE_ROOT/logs/$label.log" 2>&1 &
  pid=$!
  pids="$pids $pid"
}

# This fresh disposable profile may receive local D1 migrations. Protected or
# pre-existing roots are impossible here, and no remote flag is accepted.
/usr/bin/env -i \
  PATH="$SAFE_PATH" HOME="$STATE_ROOT/home" TMPDIR="$STATE_ROOT/tmp" \
  "$PNPM_BIN" --dir "$HARBOR_REPO" exec wrangler d1 migrations apply harbor-ap4m-demo-local-only \
    --local \
    --persist-to "$STATE_ROOT/harbor" \
    --config "$HARBOR_REPO/wrangler.ap4m-demo.jsonc" >/dev/null

start_process harbor /usr/bin/env -i \
  PATH="$SAFE_PATH" HOME="$STATE_ROOT/home" TMPDIR="$STATE_ROOT/tmp" \
  HARBOR_MOCK=1 AP4M_PURCHASE_MODE=mock EXEC_NETWORK=testnet MAINNET_EXECUTION=false \
  "$PNPM_BIN" --dir "$HARBOR_REPO" exec wrangler dev \
    --local --ip "$HARBOR_HOST" --port "$HARBOR_PORT" \
    --persist-to "$STATE_ROOT/harbor" \
    --show-interactive-dev-session=false \
    --config "$HARBOR_REPO/wrangler.ap4m-demo.jsonc"

start_process pilot /usr/bin/env -i \
  PATH="$SAFE_PATH" HOME="$STATE_ROOT/home" TMPDIR="$STATE_ROOT/tmp" \
  NODE_ENV=development HARBOR_MOCK=1 MASTERCARD_OF_MODE=mock EXEC_NETWORK=testnet \
  AP4M_DEMO_ENABLED=true NEXT_PUBLIC_DEV_SIGNER=0 \
  HARBOR_URL="http://$HARBOR_HOST:$HARBOR_PORT" \
  AP4M_MERCHANTS_URL="http://$MERCHANT_HOST:$MERCHANT_PORT" \
  AP4M_MERCHANT_EVENTS_URL="http://$MERCHANT_HOST:$MERCHANT_PORT/events" \
  "$PNPM_BIN" --dir "$PILOT_REPO" --filter web exec next dev \
    --hostname "$PILOT_HOST" --port "$PILOT_PORT"

start_process merchants /usr/bin/env -i \
  PATH="$SAFE_PATH" HOME="$STATE_ROOT/home" TMPDIR="$STATE_ROOT/tmp" \
  AP4M_MERCHANT_MODE=mock EXEC_NETWORK=testnet \
  "$UV_BIN" run --offline --locked --project "$PILOT_REPO/services/ap4m-merchants" \
    uvicorn app.main:app --host "$MERCHANT_HOST" --port "$MERCHANT_PORT"

# The mm-loop owns its existing Testnet key-loading contract. Only its required
# values are allowlisted, and this branch is unreachable without the event gate.
if [ "$MM_LOOP_MODE" = "testnet" ]; then
  start_process mm-loop /usr/bin/env -i \
    PATH="$SAFE_PATH" HOME="$STATE_ROOT/home" TMPDIR="$STATE_ROOT/tmp" \
    EXEC_NETWORK=testnet \
    MM_WALLET_SEED="${MM_WALLET_SEED:-}" \
    STABLE_CODE="${STABLE_CODE:-}" \
    STABLE_ISSUER_TESTNET="${STABLE_ISSUER_TESTNET:-}" \
    XRPL_TESTNET_URL="${XRPL_TESTNET_URL:-}" \
    XRPL_MAINNET_URL="${XRPL_MAINNET_URL:-}" \
    "$PNPM_BIN" --dir "$PILOT_REPO" tsx scripts/mm-loop.ts --network testnet
fi

printf '%s\n' "[ap4m-local] mock AP4M stack started; mm-loop=$MM_LOOP_MODE state_root=$STATE_ROOT"
printf '%s\n' "[ap4m-local] Pilot=http://$PILOT_HOST:$PILOT_PORT Harbor=http://$HARBOR_HOST:$HARBOR_PORT Merchants=http://$MERCHANT_HOST:$MERCHANT_PORT"
wait
