#!/usr/bin/env bash

# Provision Harbor's one allowed Worker and D1 database, plus test-ledger fixtures.
# This script deliberately never lists account-wide Cloudflare resources and never
# writes secret values to stdout/stderr.

set -Eeuo pipefail
set +x
umask 077

readonly RUN_ENV="/absolute/private/pilot/run.env"
readonly SECRET_DIR="/absolute/private/pilot/harbor-secrets"
readonly HARBOR_ENV="$SECRET_DIR/harbor.dev.vars"
readonly PILOT_ENV="/absolute/private/pilot/pilot-secrets/pilot.env.local"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly WRANGLER_CONFIG="$REPO_ROOT/wrangler.jsonc"
readonly DECISIONS_FILE="/absolute/private/pilot/evidence/bootstrap-audit.md"
readonly TESTNET_RPC="https://s.altnet.rippletest.net:51234"
readonly DEVNET_RPC="https://s.devnet.rippletest.net:51234"
readonly TESTNET_FAUCET="https://faucet.altnet.rippletest.net/accounts"
readonly DEVNET_FAUCET="https://faucet.devnet.rippletest.net/accounts"
readonly LOADER_PROBE_PORT=8798
readonly COMPATIBILITY_DATE="2026-10-17"

TEMP_DIR=""
PROBE_PID=""

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$PROBE_PID" ]] && kill -0 "$PROBE_PID" 2>/dev/null; then
    kill "$PROBE_PID" 2>/dev/null || true
    wait "$PROBE_PID" 2>/dev/null || true
  fi
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

wrangler() {
  # Bootstrap requires npm ci first; never fetch an unpinned CLI implicitly.
  (cd "$REPO_ROOT" && npx --no-install wrangler "$@")
}

validate_resource_name() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
    die "$label is not a valid scoped resource name"
}

read_run_value() {
  local key="$1"

  awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    {
      equals = index($0, "=")
      if (equals == 0) next
      name = substr($0, 1, equals - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != wanted) next
      value = substr($0, equals + 1)
      sub(/[[:space:]]*#.*/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      found++
      result = value
    }
    END {
      if (found != 1 || result == "") exit 1
      print result
    }
  ' "$RUN_ENV" || die "expected exactly one non-empty $key entry in $RUN_ENV"
}

get_key() {
  local file="$1"
  local key="$2"
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done < "$file"
  return 1
}

# Replace only the requested key. All unrelated lines retain their order and bytes.
upsert_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp line seen=0

  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid environment key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "multiline environment value rejected"
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      if [[ "$seen" -eq 0 ]]; then
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
        seen=1
      fi
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$file"
  if [[ "$seen" -eq 0 ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$file"
}

upsert_decision() {
  local subject="$1"
  local decision="$2"
  local reason="$3"
  local marker="| P1.0 | $subject "
  local today tmp line seen=0

  today="$(date -u +%Y-%m-%d)"
  tmp="$(mktemp "${DECISIONS_FILE}.tmp.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *"$marker"* ]]; then
      if [[ "$seen" -eq 0 ]]; then
        printf '%s | P1.0 | %s %s | %s\n' "$today" "$subject" "$decision" "$reason" >> "$tmp"
        seen=1
      fi
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$DECISIONS_FILE"
  if [[ "$seen" -eq 0 ]]; then
    printf '%s | P1.0 | %s %s | %s\n' "$today" "$subject" "$decision" "$reason" >> "$tmp"
  fi
  chmod 644 "$tmp"
  mv -f -- "$tmp" "$DECISIONS_FILE"
}

retry_post() {
  local url="$1"
  local body="$2"
  local output="$3"
  local started now
  local retry_seconds="${XRPL_BOOTSTRAP_RETRY_SECONDS:-1800}"

  [[ "$retry_seconds" =~ ^[0-9]+$ ]] || die "XRPL_BOOTSTRAP_RETRY_SECONDS must be an integer"
  started="$(date +%s)"
  while true; do
    if curl --fail --silent --show-error --max-time 20 \
      --header 'content-type: application/json' \
      --data "$body" "$url" > "$output" 2>/dev/null; then
      return 0
    fi
    now="$(date +%s)"
    (( now - started < retry_seconds )) || return 1
    sleep 15
  done
}

# The public `feature` method accepts an amendment short name. It returns either
# result directly or result.features depending on the rippled API version.
# https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/feature
probe_feature() {
  local network="$1"
  local rpc_url="$2"
  local feature="$3"
  local response="$TEMP_DIR/feature-${network}-${feature}.json"
  local body

  body="$(printf '{"method":"feature","params":[{"feature":"%s"}]}' "$feature")"
  retry_post "$rpc_url" "$body" "$response" ||
    die "$network endpoint remained unreachable for the configured retry window"

  node - "$response" "$feature" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const feature = process.argv[3];
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const result = payload && payload.result;
const table = result && typeof result === 'object' ? (result.features || result) : {};
const entries = Object.values(table).filter((entry) => entry && typeof entry === 'object');
const match = entries.find((entry) => entry.name === feature);
if (!match) {
  process.stdout.write('false|false');
} else {
  process.stdout.write(`${match.enabled === true}|${match.supported === true}`);
}
NODE
}

valid_wallet_fixture() {
  local fixture="$1"
  printf '%s' "$fixture" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(input);
        const ok = Array.isArray(value) && value.length === 3 && value.every(
          (wallet) => wallet && typeof wallet.address === "string" && typeof wallet.seed === "string" && wallet.address && wallet.seed
        );
        process.exit(ok ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  ' >/dev/null 2>&1
}

fund_wallets() {
  local network="$1"
  local faucet_url="$2"
  local network_upper
  local env_key
  local existing="" wallet_file response_file address fixture index

  network_upper="$(printf '%s' "$network" | tr '[:lower:]' '[:upper:]')"
  env_key="TEST_WALLETS_${network_upper}"

  existing="$(get_key "$HARBOR_ENV" "$env_key" || true)"
  if [[ -n "$existing" ]] && valid_wallet_fixture "$existing"; then
    log "$network faucet wallets already present"
    return 0
  fi

  wallet_file="$TEMP_DIR/${network}-wallets.json"
  response_file="$TEMP_DIR/${network}-faucet-response.json"
  node --input-type=module > "$wallet_file" <<'NODE'
import { Wallet } from 'xrpl';
const wallets = Array.from({ length: 3 }, () => Wallet.generate());
if (wallets.some((wallet) => typeof wallet.seed !== 'string' || !wallet.seed)) process.exit(1);
process.stdout.write(JSON.stringify(wallets.map((wallet) => ({ address: wallet.address, seed: wallet.seed }))));
NODE
  chmod 600 "$wallet_file"

  for index in 0 1 2; do
    address="$(node -e '
      const fs = require("node:fs");
      const wallets = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(wallets[Number(process.argv[2])].address);
    ' "$wallet_file" "$index")"
    retry_post "$faucet_url" "$(printf '{"destination":"%s"}' "$address")" "$response_file" ||
      die "$network faucet remained unreachable for the configured retry window"
    node - "$response_file" <<'NODE' >/dev/null || die "$network faucet rejected a wallet funding request"
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!payload || payload.error || payload.success === false || (payload.result && payload.result.error)) process.exit(1);
NODE
  done

  fixture="$(<"$wallet_file")"
  upsert_key "$HARBOR_ENV" "$env_key" "$fixture"
  log "$network faucet wallets funded and stored"
}

extract_d1_id() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const parsed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const value = Array.isArray(parsed) ? parsed[0] : parsed;
const candidates = [
  value.uuid,
  value.id,
  value.database_id,
  value.result && value.result.uuid,
  value.result && value.result.id,
  value.result && value.result.database_id,
];
const id = candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0);
if (!id) process.exit(1);
process.stdout.write(id);
NODE
}

configure_wrangler() {
  local database_id="$1"
  local exec_network="$2"
  local executor="$3"

  node - "$WRANGLER_CONFIG" "$WORKER_NAME" "$D1_NAME" "$database_id" "$exec_network" "$executor" <<'NODE'
const fs = require('node:fs');
const [file, workerName, databaseName, databaseId, execNetwork, executor] = process.argv.slice(2);

function parseJsonc(source) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      output += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      output += char;
    }
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, '$1'));
}

const config = parseJsonc(fs.readFileSync(file, 'utf8'));
if (config.name && config.name !== workerName) throw new Error('wrangler name is outside run.env scope');
config.name = workerName;

config.d1_databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
let db = config.d1_databases.find((entry) => entry.binding === 'DB');
if (!db) {
  db = { binding: 'DB', database_name: databaseName, database_id: databaseId };
  config.d1_databases.push(db);
}
if (db.database_name && db.database_name !== databaseName) throw new Error('DB binding is outside run.env scope');
db.binding = 'DB';
db.database_name = databaseName;
db.database_id = databaseId;

config.worker_loaders = Array.isArray(config.worker_loaders) ? config.worker_loaders : [];
if (!config.worker_loaders.some((entry) => entry.binding === 'LOADER')) {
  config.worker_loaders.push({ binding: 'LOADER' });
}

config.triggers = config.triggers && typeof config.triggers === 'object' ? config.triggers : {};
config.triggers.crons = Array.isArray(config.triggers.crons) ? config.triggers.crons : [];
if (!config.triggers.crons.includes('* * * * *')) config.triggers.crons.push('* * * * *');

config.vars = config.vars && typeof config.vars === 'object' ? config.vars : {};
config.vars.HARBOR_SOURCE_TAG = '2610240';
config.vars.EXEC_NETWORK = execNetwork;
config.vars.MAINNET_EXECUTION = 'false';
config.vars.EXECUTOR = executor;

const temp = `${file}.bootstrap-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
fs.renameSync(temp, file);
NODE
}

put_worker_secret() {
  local key="$1"
  local value="$2"
  printf '%s' "$value" | wrangler secret put "$key" \
    --name "$WORKER_NAME" --config "$WRANGLER_CONFIG" >/dev/null
}

probe_dynamic_loader() {
  local probe_dir="$TEMP_DIR/loader-probe"
  local result="" attempt
  mkdir -p "$probe_dir"

  # Worker Loader configuration and API follow Cloudflare's documented Dynamic
  # Workers starter. Outbound network access is explicitly blocked.
  # https://developers.cloudflare.com/dynamic-workers/getting-started/
  printf '%s\n' "{
    \"name\": \"$WORKER_NAME\",
    \"main\": \"probe.mjs\",
    \"compatibility_date\": \"$COMPATIBILITY_DATE\",
    \"worker_loaders\": [{ \"binding\": \"LOADER\" }]
  }" > "$probe_dir/wrangler.jsonc"
  cat > "$probe_dir/probe.mjs" <<'PROBE'
export default {
  async fetch(request, env) {
    const worker = env.LOADER.load({
      compatibilityDate: '2026-10-17',
      mainModule: 'worker.js',
      modules: {
        'worker.js': `export default { fetch() { return new Response(String(1 + 1)); } };`,
      },
      globalOutbound: null,
    });
    return worker.getEntrypoint().fetch(request);
  },
};
PROBE

  wrangler dev --remote --ip 127.0.0.1 --port "$LOADER_PROBE_PORT" \
    --config "$probe_dir/wrangler.jsonc" --log-level error \
    --show-interactive-dev-session false > "$probe_dir/wrangler.log" 2>&1 &
  PROBE_PID=$!

  for attempt in {1..60}; do
    if result="$(curl --fail --silent --max-time 2 "http://127.0.0.1:${LOADER_PROBE_PORT}/" 2>/dev/null)"; then
      [[ "$result" == "2" ]] && return 0
      return 1
    fi
    kill -0 "$PROBE_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

probe_quickjs() {
  node --input-type=module >/dev/null 2>&1 <<'NODE'
import { getQuickJS } from 'quickjs-emscripten';
const QuickJS = await getQuickJS();
const vm = QuickJS.newContext();
const result = vm.evalCode('1 + 1');
if (result.error) {
  result.error.dispose();
  vm.dispose();
  process.exit(1);
}
const value = vm.dump(result.value);
result.value.dispose();
vm.dispose();
process.exit(value === 2 ? 0 : 1);
NODE
}

main() {
  local kek api_keys api_token api_pair
  local testnet_delegation devnet_delegation
  local enabled supported feature status network rpc_url
  local exec_network executor="dynamic"
  local d1_info d1_lookup_config d1_id

  (( $# == 0 )) || die "this script accepts no arguments"

  require_command curl
  require_command node
  require_command npm
  require_command npx
  require_command openssl
  [[ -f "$RUN_ENV" ]] || die "missing run names: $RUN_ENV"
  [[ -f "$WRANGLER_CONFIG" ]] || die "missing wrangler.jsonc; create the Worker scaffold first"
  [[ -f "$REPO_ROOT/migrations/0001_init.sql" ]] || die "missing D1 migration"

  # Parse, but never execute, the run kit's sole naming authority.
  HARBOR_REPO="$(read_run_value HARBOR_REPO)"
  WORKER_NAME="$(read_run_value WORKER_NAME)"
  D1_NAME="$(read_run_value D1_NAME)"
  validate_resource_name HARBOR_REPO "$HARBOR_REPO"
  validate_resource_name WORKER_NAME "$WORKER_NAME"
  validate_resource_name D1_NAME "$D1_NAME"
  [[ "$WORKER_NAME" == "$HARBOR_REPO" && "$D1_NAME" == "$HARBOR_REPO" ]] ||
    die "run.env Worker, D1, and Harbor repository names must match"

  mkdir -p "$SECRET_DIR" "$REPO_ROOT/decisions"
  chmod 700 "$SECRET_DIR"
  touch "$HARBOR_ENV" "$PILOT_ENV" "$DECISIONS_FILE"
  chmod 600 "$HARBOR_ENV" "$PILOT_ENV"
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/harbor-bootstrap.XXXXXX")"
  chmod 700 "$TEMP_DIR"

  kek="$(get_key "$HARBOR_ENV" HARBOR_KEK || true)"
  if [[ -z "$kek" ]]; then
    kek="$(openssl rand -base64 32 | tr -d '\r\n')"
    upsert_key "$HARBOR_ENV" HARBOR_KEK "$kek"
  fi

  api_keys="$(get_key "$HARBOR_ENV" HARBOR_API_KEYS || true)"
  api_pair=""
  if [[ -n "$api_keys" ]]; then
    IFS=',' read -r -a configured_api_keys <<< "$api_keys"
    for api_pair_candidate in "${configured_api_keys[@]}"; do
      if [[ "$api_pair_candidate" == austin:* && -n "${api_pair_candidate#austin:}" ]]; then
        api_pair="$api_pair_candidate"
        break
      fi
    done
  fi
  if [[ -z "$api_pair" ]]; then
    api_token="$(openssl rand -hex 32)"
    api_pair="austin:$api_token"
    api_keys="${api_keys:+${api_keys},}${api_pair}"
    upsert_key "$HARBOR_ENV" HARBOR_API_KEYS "$api_keys"
  fi

  for network in testnet devnet; do
    if [[ "$network" == testnet ]]; then rpc_url="$TESTNET_RPC"; else rpc_url="$DEVNET_RPC"; fi
    for feature in PermissionDelegationV1_1 SingleAssetVault LendingProtocol; do
      status="$(probe_feature "$network" "$rpc_url" "$feature")"
      IFS='|' read -r enabled supported <<< "$status"
      upsert_decision "$network $feature" "enabled=$enabled supported=$supported" \
        "Result of the XRPL public feature method."
      if [[ "$feature" == PermissionDelegationV1_1 ]]; then
        if [[ "$network" == testnet ]]; then testnet_delegation="$enabled"; else devnet_delegation="$enabled"; fi
      fi
    done
  done

  if [[ "$testnet_delegation" == true ]]; then
    exec_network="testnet"
    upsert_decision "execution network" "set to testnet" \
      "PermissionDelegationV1_1 was enabled on testnet."
  elif [[ "$devnet_delegation" == true ]]; then
    exec_network="devnet"
    upsert_decision "execution network" "set to devnet" \
      "PermissionDelegationV1_1 was not enabled on testnet but was enabled on devnet."
  else
    die "PermissionDelegationV1_1 is enabled on neither testnet nor devnet"
  fi

  upsert_key "$HARBOR_ENV" HARBOR_SOURCE_TAG 2610240
  upsert_key "$HARBOR_ENV" EXEC_NETWORK "$exec_network"
  upsert_key "$HARBOR_ENV" MAINNET_EXECUTION false
  upsert_key "$HARBOR_ENV" EXECUTOR "$executor"
  # This flag is consumed only by local Wrangler through the .dev.vars symlink.
  # It is deliberately excluded from put_worker_secret and wrangler.jsonc vars.
  upsert_key "$HARBOR_ENV" HARBOR_LOCAL_DEV true
  upsert_key "$PILOT_ENV" HARBOR_API_KEY "$api_pair"
  upsert_key "$PILOT_ENV" HARBOR_URL http://localhost:8799
  upsert_key "$PILOT_ENV" EXEC_NETWORK "$exec_network"
  upsert_key "$PILOT_ENV" HARBOR_MOCK 1

  d1_info="$TEMP_DIR/d1-info.json"
  d1_lookup_config="$TEMP_DIR/wrangler-d1-lookup.jsonc"
  printf '%s\n' "{\"name\":\"$WORKER_NAME\",\"main\":\"noop.mjs\",\"compatibility_date\":\"$COMPATIBILITY_DATE\"}" > "$d1_lookup_config"
  printf '%s\n' 'export default { fetch() { return new Response("ok"); } };' > "$TEMP_DIR/noop.mjs"
  if ! wrangler d1 info "$D1_NAME" --json --config "$d1_lookup_config" > "$d1_info" 2>/dev/null; then
    log "creating scoped D1 database $D1_NAME"
    wrangler d1 create "$D1_NAME" --binding DB --update-config \
      --config "$d1_lookup_config" >/dev/null
    wrangler d1 info "$D1_NAME" --json --config "$d1_lookup_config" > "$d1_info"
  fi
  d1_id="$(extract_d1_id "$d1_info")" || die "Wrangler did not return the scoped D1 database ID"
  configure_wrangler "$d1_id" "$exec_network" "$executor"

  put_worker_secret HARBOR_KEK "$kek"
  put_worker_secret HARBOR_API_KEYS "$api_keys"
  CI=1 wrangler d1 migrations apply "$D1_NAME" --local --config "$WRANGLER_CONFIG"
  CI=1 wrangler d1 migrations apply "$D1_NAME" --remote --config "$WRANGLER_CONFIG"

  fund_wallets testnet "$TESTNET_FAUCET"
  fund_wallets devnet "$DEVNET_FAUCET"

  if probe_dynamic_loader; then
    upsert_decision "executor" "set to dynamic" \
      "The remote Worker Loader probe evaluated 1+1 as 2 with outbound access blocked."
  else
    if ! probe_quickjs; then
      die "Worker Loader and QuickJS fallback probes both failed"
    fi
    executor="quickjs"
    upsert_key "$HARBOR_ENV" EXECUTOR "$executor"
    configure_wrangler "$d1_id" "$exec_network" "$executor"
    upsert_decision "executor" "set to quickjs" \
      "The remote Worker Loader probe failed; the QuickJS 1+1 fallback probe passed."
  fi

  # Enforce the mainnet guard after every branch and every rerun.
  upsert_key "$HARBOR_ENV" MAINNET_EXECUTION false
  log "Harbor bootstrap complete (no secret values were printed)"
}

main "$@"
