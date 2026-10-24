#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
source_file="$root/services/harbor/src/contracts.ts"
target_file="$root/packages/contracts/src/index.ts"
hash_file="$root/packages/contracts/CONTRACT_HASH"
mode="${1:---check}"
actual="$(shasum -a 256 "$source_file" | awk '{print $1}')"
case "$mode" in
  --check)
    test -f "$target_file" && test -f "$hash_file"
    cmp -s "$source_file" "$target_file"
    test "$(tr -d '\n' < "$hash_file")" = "$actual"
    ;;
  --write)
    cp "$source_file" "$target_file"
    printf '%s\n' "$actual" > "$hash_file"
    ;;
  *) printf 'usage: %s [--check|--write]\n' "$0" >&2; exit 2 ;;
esac
