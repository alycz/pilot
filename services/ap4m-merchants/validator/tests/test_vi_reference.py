import asyncio
import json
from datetime import datetime
from pathlib import Path

from validator import (
    ChallengeContext,
    MerchantValidationRequest,
    PinnedReferenceViVerifier,
    REFERENCE_COMMIT,
    SettlementAsset,
)
from validator._vendor.verifiable_intent.crypto.sd_jwt import decode_sd_jwt
from validator._vendor.verifiable_intent.crypto.signing import jwk_to_public_key
from validator._vendor.verifiable_intent.verification import chain as reference_chain


FIXTURES = Path(__file__).parent / "fixtures"
PINNED_PATH = FIXTURES / "vi-ap4m-reference-v0.1.json"
MH4_PATH = FIXTURES / "ap4m-mh4-mm2-v1.json"


def _epoch(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def _challenge(mh4: dict[str, object]) -> ChallengeContext:
    merchant = mh4["merchant"]
    x402 = mh4["x402"]["validated_challenge"]
    return ChallengeContext(
        state_id="s" * 43,
        merchant_id=merchant["id"],
        merchant_name=x402["resource"]["serviceName"],
        src_dpa_id="demo-dpa-venue-yield-desk",
        merchant_address=merchant["address"],
        sku=merchant["sku"],
        price_usd_cents=100,
        settlement=SettlementAsset("RLUSD", merchant["issuer"], x402["amount"]),
        network_id=1,
        source_tag=merchant["source_tag"],
        destination_tag=None,
        invoice_id=x402["invoiceId"],
        l3a_digest=mh4["vi"]["l3a_digest"],
        current_ledger_index=1_000,
        max_last_ledger_delta=20,
        max_fee_drops=100,
    )


def test_vendored_reference_verifies_pinned_public_l1_l2(monkeypatch) -> None:
    fixture = json.loads(PINNED_PATH.read_text())
    assert fixture["reference_commit"] == REFERENCE_COMMIT
    monkeypatch.setattr(reference_chain.time, "time", lambda: _epoch(fixture["now"]))

    l1 = decode_sd_jwt(fixture["l1"])
    l2 = decode_sd_jwt(fixture["l2"])
    result = reference_chain.verify_chain(
        l1,
        l2,
        issuer_public_key=jwk_to_public_key(fixture["issuer_public_jwk"]),
        clock_skew_seconds=0,
        l1_serialized=fixture["l1"],
        l2_serialized=fixture["l2"],
        expected_l2_aud=fixture["audience"],
        expected_l2_nonce=fixture["mandate_id"],
    )

    assert result.valid is True
    assert result.errors == []
    assert result.mandate_pair_count == 1
    assert result.checks_skipped == ["l1_card_id_cross_check"]
    assert result.l1_claims["of_owner_name_hash"] == "1" * 64
    assert result.l1_claims["of_customer_ref"] == "2" * 64


def test_vendored_reference_rejects_tampered_public_signature(monkeypatch) -> None:
    fixture = json.loads(PINNED_PATH.read_text())
    monkeypatch.setattr(reference_chain.time, "time", lambda: _epoch(fixture["now"]))
    compact, suffix = fixture["l1"].split("~", 1)
    header, payload, signature = compact.split(".")
    replacement = "A" if signature[-1] != "A" else "B"
    tampered = f"{header}.{payload}.{signature[:-1]}{replacement}~{suffix}"

    result = reference_chain.verify_chain(
        decode_sd_jwt(tampered),
        decode_sd_jwt(fixture["l2"]),
        issuer_public_key=jwk_to_public_key(fixture["issuer_public_jwk"]),
        clock_skew_seconds=0,
        l1_serialized=tampered,
        l2_serialized=fixture["l2"],
        expected_l2_aud=fixture["audience"],
        expected_l2_nonce=fixture["mandate_id"],
    )
    assert result.valid is False
    assert result.errors == ["L1 signature verification failed"]


def _mh4_verifier_request(
    fixture: dict[str, object], monkeypatch
) -> tuple[PinnedReferenceViVerifier, MerchantValidationRequest]:
    monkeypatch.setattr(
        reference_chain.time, "time", lambda: _epoch(fixture["generated_at"])
    )
    verifier = PinnedReferenceViVerifier(
        fixture["keys"]["issuer_public_jwk"],
        expected_issuer_kid="demo-network-mh4-fixture",
        expected_l2_audience="https://harbor.example/ap4m/agent",
    )
    request = MerchantValidationRequest(
        challenge=_challenge(fixture),
        network="testnet",
        intent=fixture["intent"],
        vi_chain=None,
        payment_proof=None,
        authority="merchant.example",
        path="/resource/yield-report",
        expected_mandate_id="00000000-0000-4000-8000-000000000404",
        expected_l3_nonce="mh4-l3b-nonce-0002",
    )
    return verifier, request


def test_concrete_adapter_verifies_complete_mh4_chain(monkeypatch) -> None:
    fixture = json.loads(MH4_PATH.read_text())
    verifier, request = _mh4_verifier_request(fixture, monkeypatch)
    vi = fixture["vi"]

    verified = asyncio.run(
        verifier(
            {
                "version": "vi-v0.1",
                "l1": vi["l1"],
                "l2": vi["l2"],
                "l3b": vi["l3b"],
            },
            request,
        )
    )
    assert verified.signatures_valid is True
    assert verified.l1_l2_bound is True
    assert verified.l2_l3_bound is True
    assert verified.payer == "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"
    assert verified.allowed_merchants == ("venue-yield-desk",)
    assert verified.allowed_payees == ("venue-yield-desk",)
    assert verified.allowed_skus == ("yield-report",)
    assert verified.per_payment_max_usd_cents == 100
    assert verified.recurrence == "ON_DEMAND"
    assert verified.checkout_hash == vi["checkout_hash"]


def test_concrete_adapter_verifies_exact_mh4_selective_merchant_wire(monkeypatch) -> None:
    fixture = json.loads(MH4_PATH.read_text())
    verifier, request = _mh4_verifier_request(fixture, monkeypatch)
    vi = fixture["vi"]

    verified = asyncio.run(
        verifier(
            {
                "version": "vi-v0.1",
                "l1": vi["l1"],
                "l2": vi["l2_presentations"]["merchant"],
                "l3b": vi["l3b"],
            },
            request,
        )
    )
    assert verified.signatures_valid is True
    assert verified.allowed_payees == ("venue-yield-desk",)
    assert verified.allowed_merchants == ("venue-yield-desk",)
    assert verified.allowed_skus == ("yield-report",)
    assert verified.payer == "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"
    assert verified.checkout_hash == vi["checkout_hash"]
