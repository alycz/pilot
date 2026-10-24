#!/bin/sh
set -eu

mode="${1:-}"
: "${HARBOR_REPO_PATH:?set HARBOR_REPO_PATH to an explicit Harbor checkout}"
: "${HARBOR_CONTRACT_REF:?set HARBOR_CONTRACT_REF to an immutable Harbor commit}"
: "${HARBOR_CONTRACT_SHA256:?set HARBOR_CONTRACT_SHA256 to the reviewed contract digest}"

case "$mode" in
  --check|--write) ;;
  *)
    printf 'usage: HARBOR_REPO_PATH=... HARBOR_CONTRACT_REF=... HARBOR_CONTRACT_SHA256=... %s --check|--write\n' "$0" >&2
    exit 2
    ;;
esac

if [ "${#HARBOR_CONTRACT_REF}" -ne 40 ]; then
  printf 'HARBOR_CONTRACT_REF must be an exact 40-character lowercase commit SHA\n' >&2
  exit 2
fi
case "$HARBOR_CONTRACT_REF" in
  *[!0-9a-f]*)
    printf 'HARBOR_CONTRACT_REF must be an exact 40-character lowercase commit SHA\n' >&2
    exit 2
    ;;
esac
if [ "${#HARBOR_CONTRACT_SHA256}" -ne 64 ]; then
  printf 'HARBOR_CONTRACT_SHA256 must be an exact 64-character lowercase digest\n' >&2
  exit 2
fi
case "$HARBOR_CONTRACT_SHA256" in
  *[!0-9a-f]*)
    printf 'HARBOR_CONTRACT_SHA256 must be an exact 64-character lowercase digest\n' >&2
    exit 2
    ;;
esac

harbor_repo_path="$HARBOR_REPO_PATH"
pilot_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
contract_source="$pilot_root/packages/contracts/src/index.ts"
contract_hash="$pilot_root/packages/contracts/CONTRACT_HASH"
temporary_source="$(mktemp "${TMPDIR:-/tmp}/pilot-contracts.XXXXXX")"

trap 'rm -f "$temporary_source"' EXIT

harbor_commit="$(git -C "$harbor_repo_path" rev-parse --verify "$HARBOR_CONTRACT_REF^{commit}")"
if [ "$harbor_commit" != "$HARBOR_CONTRACT_REF" ]; then
  printf 'Harbor ref did not resolve to the exact requested commit\n' >&2
  exit 1
fi
git -C "$harbor_repo_path" show "$harbor_commit:src/contracts.ts" >"$temporary_source"
actual_hash="$(shasum -a 256 "$temporary_source" | awk '{print $1}')"

if [ "$actual_hash" != "$HARBOR_CONTRACT_SHA256" ]; then
  printf 'Harbor contract digest mismatch: expected %s, received %s\n' "$HARBOR_CONTRACT_SHA256" "$actual_hash" >&2
  exit 1
fi

if [ "$mode" = "--check" ]; then
  cmp -s "$temporary_source" "$contract_source" || {
    printf 'Pilot contract bytes differ from Harbor commit %s\n' "$harbor_commit" >&2
    exit 1
  }
  recorded_hash="$(tr -d '[:space:]' <"$contract_hash")"
  if [ "$recorded_hash" != "$actual_hash" ]; then
    printf 'Pilot CONTRACT_HASH mismatch: expected %s, received %s\n' "$actual_hash" "$recorded_hash" >&2
    exit 1
  fi
  printf 'Verified Harbor contracts from %s: %s\n' "$harbor_commit" "$actual_hash"
  exit 0
fi

cp "$temporary_source" "$contract_source"
printf '%s\n' "$actual_hash" >"$contract_hash"

printf 'Synced Harbor contracts from %s: %s\n' "$harbor_commit" "$actual_hash"
