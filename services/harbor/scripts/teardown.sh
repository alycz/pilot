#!/usr/bin/env bash

set -Eeuo pipefail

# Resource names must come from the run kit so this script cannot drift to a
# Worker or database outside the scope approved for this run.
readonly RUN_ENV="/absolute/private/pilot/run.env"
readonly SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)"

die() {
  printf 'teardown: %s\n' "$*" >&2
  exit 1
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
  ' "$RUN_ENV" || die "expected exactly one non-empty ${key} entry in ${RUN_ENV}"
}

validate_resource_name() {
  local label="$1"
  local value="$2"

  case "$value" in
    ''|*[!a-z0-9-]*|-*|*-)
      die "${label} has an unsafe resource name: ${value}"
      ;;
  esac

  if (( ${#value} > 63 )); then
    die "${label} exceeds the 63-character resource-name limit"
  fi
}

wrangler() {
  # Do not download a different Wrangler version during a destructive action.
  (cd -- "$PROJECT_DIR" && npx --no-install wrangler "$@")
}

is_absent_error() {
  local resource_name="$1"
  local output="$2"

  # Treat only a name-specific not-found response as idempotent success. Auth,
  # network, and other failures must stop teardown instead of being hidden.
  printf '%s\n' "$output" | grep -Fqi -- "$resource_name" &&
    printf '%s\n' "$output" | grep -Eqi -- \
      "not found|does not exist|doesn't exist|could not find|couldn't find|no .* found"
}

delete_worker() {
  local output
  local status

  set +e
  # https://developers.cloudflare.com/workers/wrangler/commands/workers/#delete
  output="$(printf 'y\n' | wrangler delete "$WORKER_NAME" 2>&1)"
  status=$?
  set -e

  if (( status == 0 )); then
    printf 'Deleted Worker %s.\n' "$WORKER_NAME"
  elif is_absent_error "$WORKER_NAME" "$output"; then
    printf 'Worker %s is already absent.\n' "$WORKER_NAME"
  else
    printf '%s\n' "$output" >&2
    die "failed to delete Worker ${WORKER_NAME}"
  fi
}

delete_database() {
  local output
  local status

  set +e
  # https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-delete
  output="$(wrangler d1 delete "$D1_NAME" --skip-confirmation 2>&1)"
  status=$?
  set -e

  if (( status == 0 )); then
    printf 'Deleted D1 database %s.\n' "$D1_NAME"
  elif is_absent_error "$D1_NAME" "$output"; then
    printf 'D1 database %s is already absent.\n' "$D1_NAME"
  else
    printf '%s\n' "$output" >&2
    die "failed to delete D1 database ${D1_NAME}"
  fi
}

(( $# == 0 )) || die 'this script accepts no arguments'
[[ -f "$RUN_ENV" ]] || die "run environment file not found: ${RUN_ENV}"
command -v npx >/dev/null 2>&1 || die 'npx is required'

readonly HARBOR_REPO="$(read_run_value HARBOR_REPO)"
readonly WORKER_NAME="$(read_run_value WORKER_NAME)"
readonly D1_NAME="$(read_run_value D1_NAME)"

validate_resource_name HARBOR_REPO "$HARBOR_REPO"
validate_resource_name WORKER_NAME "$WORKER_NAME"
validate_resource_name D1_NAME "$D1_NAME"

[[ "$WORKER_NAME" == "$HARBOR_REPO" ]] ||
  die 'WORKER_NAME must exactly match HARBOR_REPO in run.env'
[[ "$D1_NAME" == "$HARBOR_REPO" ]] ||
  die 'D1_NAME must exactly match HARBOR_REPO in run.env'

# Remove the Worker first so its binding no longer refers to the D1 database.
delete_worker
delete_database

printf 'Harbor Cloudflare teardown complete. Repositories and local secrets were untouched.\n'
