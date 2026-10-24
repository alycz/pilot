#!/usr/bin/env python3
"""Verify the public MN1 L1 fixture with VI reference v0.1.0.

The reference is pinned to commit 1dc3d4189512041fb3d0f8348fe100dfe25ced91.
Set PYTHONPATH to that checkout's ``src`` directory before invoking this file.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import verifiable_intent
from verifiable_intent.crypto.sd_jwt import (
    decode_sd_jwt,
    verify_sd_jwt_signature,
)
from verifiable_intent.crypto.signing import jwk_to_public_key


REFERENCE_COMMIT = "1dc3d4189512041fb3d0f8348fe100dfe25ced91"
FIXTURE_PATH = Path(__file__).with_name("fixtures") / "vi-l1-es256.json"


def _contains_private_key(value: Any) -> bool:
    if isinstance(value, dict):
        return "d" in value or any(_contains_private_key(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_private_key(item) for item in value)
    return False


def _assert_reference_commit() -> None:
    checkout = Path(verifiable_intent.__file__).resolve().parents[2]
    actual = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != REFERENCE_COMMIT:
        raise AssertionError(
            f"VI reference commit mismatch: expected {REFERENCE_COMMIT}, got {actual}"
        )


def main() -> None:
    _assert_reference_commit()
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    if fixture.get("reference_commit") != REFERENCE_COMMIT:
        raise AssertionError("The fixture is not pinned to the expected VI reference commit")
    if _contains_private_key(fixture):
        raise AssertionError("The interop fixture contains private JWK material")

    public_key = jwk_to_public_key(fixture["issuer_public_jwk"])
    l1 = decode_sd_jwt(fixture["l1"])
    if l1.header.get("alg") != "ES256" or l1.header.get("typ") != "sd+jwt":
        raise AssertionError(f"Unexpected L1 protected header: {l1.header!r}")
    if l1.payload.get("vct") != "https://credentials.mastercard.com/card":
        raise AssertionError(f"Unexpected L1 vct: {l1.payload.get('vct')!r}")
    if l1.payload.get("_sd_alg") != "sha-256":
        raise AssertionError(f"Unexpected L1 _sd_alg: {l1.payload.get('_sd_alg')!r}")
    if not verify_sd_jwt_signature(l1, public_key):
        raise AssertionError("Python VI reference rejected the MN1 L1 signature")

    expected = fixture["expected"]
    expected_claims = {
        "budget_account": expected["budget_account"],
        "exp": expected["exp"],
        "iat": expected["iat"],
        "iss": expected["issuer"],
        "pilot_issuer_name": expected["issuer"],
        "of_customer_ref": expected["customer_ref_hash"],
        "of_owner_name_hash": expected["owner_name_hash"],
    }
    actual_claims = {key: l1.payload.get(key) for key in expected_claims}
    if actual_claims != expected_claims:
        raise AssertionError(
            f"Python VI reference decoded unexpected claims: {actual_claims!r}"
        )

    tampered = decode_sd_jwt(fixture["l1"])
    tampered.payload["sub"] = "tampered"
    if verify_sd_jwt_signature(tampered, public_key):
        raise AssertionError("Python VI reference accepted a tampered MN1 L1")

    print(
        "PASS: VI reference v0.1.0 "
        f"({REFERENCE_COMMIT}) verified the public MN1 L1 fixture and rejected tampering"
    )


if __name__ == "__main__":
    main()
