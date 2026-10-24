from __future__ import annotations

import pytest

from apps.web.api.x402.approval import (
    ApprovalEnvelopeError,
    canonical_issued_approval_envelope,
    digest_issued_approval_envelope,
)


CURRENCY = "524C555344000000000000000000000000000000"
GOLDEN_CANONICAL = (
    '{"amount":"1.25","approval_id":"rlusd-approval-0001",'
    '"asset":{"currency":"524C555344000000000000000000000000000000",'
    '"issuer":"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh","kind":"issued",'
    '"namespace":"token","network":"xrpl:1"},'
    '"domain":"pilot.x402.owner-approval","execution_network":"testnet",'
    '"idempotency_key":"owner-review-operation-0001",'
    '"merchant":{"id":"merchant-weather-api-v1",'
    '"pay_to":"rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",'
    '"resource_method":"POST",'
    '"resource_url":"https://merchant.example/v1/weather"},'
    '"merchant_invoice_id":"invoice-merchant-0001","network":"xrpl:1",'
    '"owner":"r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",'
    '"quote_expires_at":"2026-10-24T12:01:00.000Z",'
    '"session_scope":"principal-owner-review-0001",'
    '"transaction":{"fee_drops":"12","last_ledger_sequence":512,'
    '"sequence":7,"source_tag":2610240,"validated_ledger_index":500},'
    '"version":1}'
)


def _golden() -> dict[str, object]:
    return {
        "version": 1,
        "domain": "pilot.x402.owner-approval",
        "approval_id": "rlusd-approval-0001",
        "network": "xrpl:1",
        "execution_network": "testnet",
        "session_scope": "principal-owner-review-0001",
        "idempotency_key": "owner-review-operation-0001",
        "merchant": {
            "id": "merchant-weather-api-v1",
            "resource_method": "POST",
            "resource_url": "https://merchant.example/v1/weather",
            "pay_to": "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        },
        "asset": {
            "currency": CURRENCY,
            "issuer": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
            "kind": "issued",
            "namespace": "token",
            "network": "xrpl:1",
        },
        "amount": "1.25",
        "owner": "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        "quote_expires_at": "2026-10-24T12:01:00.000Z",
        "merchant_invoice_id": "invoice-merchant-0001",
        "transaction": {
            "fee_drops": "12",
            "last_ledger_sequence": 512,
            "sequence": 7,
            "source_tag": 2_610_240,
            "validated_ledger_index": 500,
        },
    }


def test_python_matches_joint_typescript_approval_envelope_golden() -> None:
    envelope = _golden()
    assert canonical_issued_approval_envelope(envelope) == GOLDEN_CANONICAL
    assert digest_issued_approval_envelope(envelope) == (
        "7E9C53C776814D340A3D37840F2983D2EECC4376355E7F4526C7D787A4C4181F"
    )


@pytest.mark.parametrize(
    "value",
    (
        {**_golden(), "amount": 1.25},
        {**_golden(), "transaction": {**_golden()["transaction"], "sequence": True}},
    ),
)
def test_canonicalizer_rejects_non_integer_string_shapes(
    value: dict[str, object],
) -> None:
    with pytest.raises(ApprovalEnvelopeError):
        canonical_issued_approval_envelope(value)
