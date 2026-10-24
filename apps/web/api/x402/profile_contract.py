from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping

from .config import MerchantConfig, require_isolated_merchant_config


MAX_PROFILE_BYTES = 64 * 1024
LEGACY_PROFILE_NAME = "wrangler.local-x402.jsonc"
ISOLATED_PROFILE_NAME = "wrangler.local-x402-isolated-v1.jsonc"
ISOLATED_SIGNING_PROFILE = "reviewed-testnet-isolated-v1"
LEGACY_HARBOR_ORIGIN = "http://127.0.0.1:8791"
ISOLATED_HARBOR_ORIGIN = "http://127.0.0.2:8792"


def validate_harbor_local_profile(
    path: Path,
    *,
    merchant_source_tag: int,
    harbor_origin: str,
) -> Mapping[str, Any]:
    """Validate the checked-in Harbor local x402 profile, never a secrets file."""

    if path.name not in {LEGACY_PROFILE_NAME, ISOLATED_PROFILE_NAME}:
        raise ValueError("expected a reviewed checked-in Harbor x402 profile")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Harbor local profile must be a regular non-symlink file")
    raw = path.read_bytes()
    if len(raw) > MAX_PROFILE_BYTES:
        raise ValueError("Harbor local profile is too large")
    try:
        profile = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Harbor local profile must be strict JSON") from exc
    if not isinstance(profile, dict) or not isinstance(profile.get("vars"), dict):
        raise ValueError("Harbor local profile is missing vars")
    expected_origin = (
        ISOLATED_HARBOR_ORIGIN
        if path.name == ISOLATED_PROFILE_NAME
        else LEGACY_HARBOR_ORIGIN
    )
    if harbor_origin != expected_origin:
        raise ValueError("Harbor local profile origin is not exact")
    variables = profile["vars"]
    expected_source_tag = str(merchant_source_tag)
    if variables.get("HARBOR_SOURCE_TAG") != expected_source_tag:
        raise ValueError(
            "Harbor HARBOR_SOURCE_TAG does not match the merchant SourceTag"
        )
    if (
        variables.get("EXEC_NETWORK") != "testnet"
        or variables.get("MAINNET_EXECUTION") != "false"
        or variables.get("HARBOR_LOCAL_X402") != "true"
    ):
        raise ValueError("Harbor local profile is not the Testnet x402-only profile")
    if path.name == ISOLATED_PROFILE_NAME:
        expected = {
            "EXECUTOR": "quickjs",
            "HARBOR_LOCAL_READ_ONLY": "true",
            "HARBOR_LOCAL_AUTH_REQUIRED": "true",
            "HARBOR_LOCAL_CRON_DISABLED": "true",
            "HARBOR_LOCAL_X402_RUNTIME_ENABLED": "true",
            "HARBOR_LOCAL_X402_SIGNING_PROFILE": ISOLATED_SIGNING_PROFILE,
            "HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED": "true",
            "HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE":
                ISOLATED_SIGNING_PROFILE,
        }
        if any(variables.get(name) != value for name, value in expected.items()):
            raise ValueError("Harbor isolated x402 profile markers are not exact")
        if any(name.startswith("HARBOR_LOCAL_TRADING") for name in variables):
            raise ValueError("Harbor isolated x402 profile contains trading markers")
    return profile


def validate_active_harbor_local_profile(path: Path, *, harbor_origin: str) -> int:
    """Compare Harbor to the same environment-resolved config the app uses."""

    merchant_config = MerchantConfig.from_env()
    if path.name == ISOLATED_PROFILE_NAME:
        require_isolated_merchant_config(merchant_config)
    source_tag = merchant_config.source_tag
    validate_harbor_local_profile(
        path,
        merchant_source_tag=source_tag,
        harbor_origin=harbor_origin,
    )
    return source_tag


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check the merchant against Harbor's checked-in local x402 profile."
    )
    parser.add_argument(
        "profile",
        type=Path,
        help="Path to Harbor's checked-in legacy or isolated x402 profile",
    )
    parser.add_argument(
        "--harbor-origin",
        required=True,
        help="Exact reviewed Harbor loopback origin for this profile",
    )
    args = parser.parse_args()
    try:
        source_tag = validate_active_harbor_local_profile(
            args.profile,
            harbor_origin=args.harbor_origin,
        )
    except ValueError as exc:
        parser.error(str(exc))
    print(
        f"Harbor local profile matches SourceTag {source_tag} on Testnet at "
        f"{args.harbor_origin}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
