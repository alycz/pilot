#!/bin/sh
set -eu

pilot_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
contract_source="$pilot_root/services/harbor/src/contracts.ts"
contract_target="$pilot_root/packages/contracts/src/index.ts"
contract_hash="$pilot_root/packages/contracts/CONTRACT_HASH"

cp "$contract_source" "$contract_target"
shasum -a 256 "$contract_target" | awk '{print $1}' >"$contract_hash"

printf 'Synced local execution-service contracts: %s\n' "$(cat "$contract_hash")"
