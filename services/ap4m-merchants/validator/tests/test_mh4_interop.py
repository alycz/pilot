"""Offline public interoperability evidence copied from Harbor MH4.

The XRPL blob in this fixture is deliberately synthetic.  These tests prove the
wire and public cryptographic bindings only; they are not settlement evidence.
"""

import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from fastapi import Request

from app.validator.base import (
    AdapterFailure,
    _decode_t54_payment_signature,
    _kernel_request,
    protected_headers,
    t54_accepted,
    t54_resource,
)
from validator import ChallengeContext, MerchantValidationRequest, SettlementAsset
from validator.vi import checkout_digest


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "ap4m-mh4-mm2-v1.json"
FIXTURE_SHA256 = "9b01e30bb77d7071d6431a8fcd530f7ac4bfefa61d1d28b886a00acde9eacb3b"
FIXTURE = json.loads(FIXTURE_PATH.read_text())


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64url_sha256(value: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(value.encode()).digest()).decode().rstrip("=")


def _compact(presentation: str) -> str:
    return presentation.split("~", 1)[0]


def _claims(presentation: str) -> dict[str, Any]:
    return json.loads(_b64url_decode(_compact(presentation).split(".")[1]))


def _disclosures(presentation: str) -> list[tuple[str, Any]]:
    result: list[tuple[str, Any]] = []
    for encoded in presentation.split("~")[1:]:
        if encoded:
            disclosure = json.loads(_b64url_decode(encoded))
            result.append((encoded, disclosure[-1]))
    return result


def _verify_es256(presentation: str, jwk: dict[str, str]) -> None:
    header, payload, signature = _compact(presentation).split(".")
    raw = _b64url_decode(signature)
    assert len(raw) == 64
    public_key = ec.EllipticCurvePublicNumbers(
        int.from_bytes(_b64url_decode(jwk["x"])),
        int.from_bytes(_b64url_decode(jwk["y"])),
        ec.SECP256R1(),
    ).public_key()
    public_key.verify(
        encode_dss_signature(int.from_bytes(raw[:32]), int.from_bytes(raw[32:])),
        f"{header}.{payload}".encode(),
        ec.ECDSA(hashes.SHA256()),
    )


def _context() -> ChallengeContext:
    merchant = FIXTURE["merchant"]
    challenge = FIXTURE["x402"]["validated_challenge"]
    return ChallengeContext(
        state_id="fixture-state",
        merchant_id=merchant["id"],
        merchant_name=challenge["resource"]["serviceName"],
        src_dpa_id="demo-dpa-venue-yield-desk",
        merchant_address=merchant["address"],
        sku=merchant["sku"],
        price_usd_cents=100,
        settlement=SettlementAsset("RLUSD", merchant["issuer"], challenge["amount"]),
        network_id=1,
        source_tag=merchant["source_tag"],
        destination_tag=None,
        invoice_id=challenge["invoiceId"],
        l3a_digest=FIXTURE["vi"]["l3a_digest"],
        current_ledger_index=1_000,
        max_last_ledger_delta=20,
        max_fee_drops=100,
        resource_description=challenge["resource"]["description"],
    )


def _request() -> Request:
    headers = [
        (name.encode(), value.encode())
        for name, value in FIXTURE["x402"]["retry_headers"].items()
        if name != "accept"
    ]
    headers.append((b"x-ap4m-challenge-state", b"fixture-state"))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("merchant.example", 443),
            "path": "/resource/yield-report",
            "raw_path": b"/resource/yield-report",
            "query_string": b"",
            "headers": headers,
        }
    )


def test_fixture_is_byte_identical_public_only_and_explicitly_synthetic() -> None:
    assert hashlib.sha256(FIXTURE_PATH.read_bytes()).hexdigest() == FIXTURE_SHA256
    assert FIXTURE["version"] == "ap4m-mh4-mm2-v1"
    assert "no Testnet submission" in FIXTURE["evidence_scope"]
    assert FIXTURE["x402"]["synthetic_payment"] == {
        "stand_in": True,
        "ledger_validated": False,
        "label": (
            "synthetic fixture only — invalid as a real signed XRPL transaction "
            "and never submitted"
        ),
        "signed_tx_blob": "DEADBEEF",
        "tx_hash": "C" * 64,
    }
    assert not re.search(
        r'"(?:d|seed|private|privateKey|mnemonic)"\s*:',
        json.dumps(FIXTURE),
        re.IGNORECASE,
    )


def test_public_vi_signatures_and_selective_disclosure_bindings_verify() -> None:
    vi = FIXTURE["vi"]
    keys = FIXTURE["keys"]
    for name, key_name in (
        ("l1", "issuer_public_jwk"),
        ("l2", "device_public_jwk"),
        ("l3a", "agent_public_jwk"),
        ("l3b", "agent_public_jwk"),
    ):
        _verify_es256(vi[name], keys[key_name])

    assert _claims(vi["l1"])["cnf"]["jwk"] == keys["device_public_jwk"]
    assert _claims(vi["l2"])["sd_hash"] == _b64url_sha256(vi["l1"])
    for name in ("l2", "l3a", "l3b"):
        permitted = set(_claims(vi[name])["_sd"])
        assert all(
            _b64url_sha256(encoded) in permitted
            for encoded, _ in _disclosures(vi[name])
        )

    parts = vi["l2_parts"]
    payment_view = f'{parts["base_jwt"]}~{parts["payment"]}~{parts["merchant"]}~'
    checkout_view = (
        f'{parts["base_jwt"]}~{parts["payment"]}~{parts["merchant"]}~'
        f'{parts["checkout"]}~{parts["item"]}~'
    )
    assert _claims(vi["l3a"])["sd_hash"] == _b64url_sha256(payment_view)
    assert _claims(vi["l3b"])["sd_hash"] == _b64url_sha256(checkout_view)

    payment = next(
        value
        for _, value in _disclosures(vi["l3a"])
        if value.get("vct") == "mandate.payment"
    )
    checkout = next(
        value
        for _, value in _disclosures(vi["l3b"])
        if value.get("vct") == "mandate.checkout"
    )
    assert payment["transaction_id"] == vi["checkout_hash"]
    assert checkout["checkout_hash"] == vi["checkout_hash"]
    assert checkout["checkout_jwt"] == vi["checkout_payload"]
    assert hashlib.sha256(vi["l3a"].encode()).hexdigest() == vi["l3a_digest"]
    assert hashlib.sha256(vi["l3b"].encode()).hexdigest() == vi["l3b_digest"]


def test_fixture_contains_the_complete_ap4m_vi_profile() -> None:
    l1 = _claims(FIXTURE["vi"]["l1"])
    assert re.fullmatch(r"[a-f0-9]{64}", l1["of_owner_name_hash"])
    assert re.fullmatch(r"[a-f0-9]{64}", l1["of_customer_ref"])

    payment = next(
        value
        for _, value in _disclosures(FIXTURE["vi"]["l2"])
        if value.get("vct") == "mandate.payment.open"
    )
    constraint_types = {constraint["type"] for constraint in payment["constraints"]}
    assert constraint_types == {
        "payment.amount",
        "payment.budget",
        "payment.allowed_payee",
        "payment.agent_recurrence",
        "payment.reference",
    }
    assert FIXTURE["reference_commit"] == (
        "1dc3d4189512041fb3d0f8348fe100dfe25ced91"
    )


def test_checkout_hash_matches_the_validator_projection() -> None:
    current = MerchantValidationRequest(
        challenge=_context(),
        network="testnet",
        intent=FIXTURE["intent"],
        vi_chain=None,
        payment_proof=None,
    )
    assert json.loads(FIXTURE["vi"]["checkout_payload"]) == {
        "intent": FIXTURE["intent"],
        "payment_terms": {
            "amount": "1",
            "currency": "RLUSD",
            "issuer": FIXTURE["merchant"]["issuer"],
            "network": "testnet",
            "payTo": FIXTURE["merchant"]["address"],
            "scheme": "exact",
        },
    }
    assert checkout_digest(current) == FIXTURE["vi"]["checkout_hash"]


def test_exact_mh4_retry_wire_projects_into_the_mm2_kernel_request() -> None:
    request = _request()
    context = _context()
    challenge = FIXTURE["x402"]["validated_challenge"]
    assert t54_resource(request, context) == challenge["resource"]
    assert t54_accepted(context) == challenge["accepted"]

    headers = protected_headers(request)
    projected = _kernel_request(request, context, headers)
    assert projected.intent == FIXTURE["intent"]
    assert projected.vi_chain == {
        "version": "vi-v0.1",
        "l1": FIXTURE["vi"]["l1"],
        "l2": FIXTURE["vi"]["l2_presentations"]["merchant"],
        "l3b": FIXTURE["vi"]["l3b"],
    }
    assert projected.payment_proof == {"type": "xrpl_exact", "tx_blob": "DEADBEEF"}
    assert projected.method == "GET"
    assert projected.authority == "merchant.example"
    assert projected.path == "/resource/yield-report"


def test_t54_retry_rejects_any_challenge_mismatch() -> None:
    challenge = FIXTURE["x402"]["validated_challenge"]
    with pytest.raises(AdapterFailure, match="payment signature does not match challenge") as exc:
        _decode_t54_payment_signature(
            FIXTURE["x402"]["payment_signature"],
            expected_resource={**challenge["resource"], "url": "https://merchant.example/wrong"},
            expected_accepted=challenge["accepted"],
        )
    assert exc.value.code == "PAYMENT_REQUIREMENTS_MISMATCH"
