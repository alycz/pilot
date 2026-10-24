"""Focused MM3 tests for the ordered validator and retry-key seam."""

import asyncio
import base64
import hashlib
import json
from dataclasses import replace
from typing import Any

import pytest
from fastapi import Request

import app.main as merchant_app
import app.validator.base as adapter_base
from app.catalog import MERCHANTS
from app.main import _challenge, _validate_acquired_paid_request
from app.validator.base import (
    AdapterFailure,
    Mm2Runtime,
    paid_retry_key,
    t54_accepted,
    t54_resource,
)
from app.validator.challenge import ChallengeStateError, InMemoryMockChallengeStore
from validator.context import MerchantValidationRequest, PaymentResult
from tests.test_mm3_paychan import (
    CHANNEL,
    PUBLIC_KEY,
    SIGNATURE,
    channel as paychan_channel,
    runtime as paychan_runtime,
)
from validator.tests.test_validator import Harness, MERCHANT, PAYER, request


PROOF: dict[str, object] = {
    "type": "xrpl_paychan_claim",
    "channel_id": "D" * 64,
    "cumulative_drops": "50000",
    "signature": "30" * 64,
    "public_key": "ED" + "11" * 32,
}

WIRE_PROOF: dict[str, object] = {
    "scheme": "xrpl-paychan",
    "channel_id": PROOF["channel_id"],
    "cumulative_drops": PROOF["cumulative_drops"],
    "signature": PROOF["signature"],
    "public_key": PROOF["public_key"],
}


def _wire_proof(proof: dict[str, object]) -> dict[str, object]:
    return {
        "scheme": "xrpl-paychan",
        "channel_id": proof["channel_id"],
        "cumulative_drops": proof["cumulative_drops"],
        "signature": proof["signature"],
        "public_key": proof["public_key"],
    }


def _b64url_json(value: object) -> str:
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _adapter_request(
    context,
    proof: dict[str, object],
    *,
    exact: bool = False,
) -> Request:
    base_scope = {
        "type": "http",
        "method": "GET",
        "scheme": "https",
        "server": ("merchant.example", 443),
        "path": "/resource",
        "raw_path": b"/resource",
        "query_string": b"",
    }
    if exact:
        unsigned = Request({**base_scope, "headers": []})
        envelope = {
            "x402Version": 2,
            "resource": t54_resource(unsigned, context),
            "accepted": t54_accepted(context),
            "payload": {"signedTxBlob": proof["tx_blob"]},
        }
        payment_signature = base64.b64encode(
            json.dumps(envelope, separators=(",", ":")).encode()
        ).decode()
    else:
        payment_signature = base64.b64encode(
            json.dumps(proof, separators=(",", ":")).encode()
        ).decode()
    headers = {
        "x-vi-l1": "public-l1.presentation",
        "x-vi-l2": "public-l2.presentation",
        "x-vi-l3b": "public-l3b.presentation",
        "x-mastercard-intent": _b64url_json(request().intent),
        "x-ap4m-challenge-state": context.state_id,
        "payment-signature": payment_signature,
    }
    return Request(
        {
            **base_scope,
            "headers": [
                (name.encode("ascii"), value.encode("ascii"))
                for name, value in headers.items()
            ],
        }
    )


def _claim_id(proof: dict[str, object]) -> str:
    material = "\x00".join(
        (
            "ap4m/paychan-claim-retry/v1",
            str(proof["channel_id"]).upper(),
            str(proof["cumulative_drops"]),
            str(proof["signature"]).upper(),
            str(proof["public_key"]).upper(),
        )
    )
    return hashlib.sha256(material.encode("ascii")).hexdigest().upper()


class FakePaychanVerifier:
    def __init__(self) -> None:
        self.retry_proofs: list[dict[str, object]] = []
        self.requests: list[MerchantValidationRequest] = []
        self.payers: list[str] = []
        self.result_overrides: dict[str, Any] = {}

    def retry_key(self, proof) -> str:
        copied = dict(proof)
        self.retry_proofs.append(copied)
        return _claim_id(copied)

    async def validate_claim(
        self,
        current: MerchantValidationRequest,
        *,
        credentialed_payer: str,
    ) -> PaymentResult:
        self.requests.append(current)
        self.payers.append(credentialed_payer)
        proof = dict(current.payment_proof or {})
        values = {
            "tx_hash": _claim_id(proof),
            "validated": True,
            "engine_result": "claim_accepted",
            "delivered_currency": "XRP",
            "delivered_issuer": None,
            "delivered_value": current.challenge.paychan_claim_drops,
        }
        values.update(self.result_overrides)
        return PaymentResult(**values)


def _run(proof: dict[str, object], verifier: FakePaychanVerifier | None = None, **deps):
    current = request(payment_proof=proof)
    harness = Harness(current)
    dependencies = replace(
        harness.dependencies(**deps),
        paychan_verifier=verifier,
    )
    return asyncio.run(__import__("validator").validate_checkout(current, dependencies))


def test_paychan_handoff_runs_only_after_credential_and_uses_normalized_ed_proof() -> None:
    verifier = FakePaychanVerifier()
    outcome = _run(dict(PROOF), verifier)

    assert outcome.validated is True
    assert [event.stage for event in outcome.events] == [
        "wba",
        "intent",
        "credential",
        "payment",
    ]
    assert outcome.tx_hash == _claim_id(PROOF)
    assert verifier.payers == [PAYER]
    assert verifier.retry_proofs == [dict(PROOF)]
    assert dict(verifier.requests[0].payment_proof or {}) == dict(PROOF)


def test_missing_paychan_dependency_keeps_the_mm3_pending_402_contract() -> None:
    outcome = _run(dict(PROOF))
    assert outcome.http_status == 402
    assert outcome.validation_errors == ("PAYCHAN_PENDING_MM3",)


def test_paychan_mode_network_and_live_gates_run_before_verifier() -> None:
    verifier = FakePaychanVerifier()
    invalid_mode = _run(dict(PROOF), verifier, payment_mode="stand-in")
    assert invalid_mode.validation_errors == ("PAYMENT_MODE_INVALID",)
    assert verifier.requests == []

    closed_live = _run(dict(PROOF), verifier, payment_mode="live")
    assert closed_live.validation_errors == ("LIVE_GATE_CLOSED",)
    assert verifier.requests == []

    current = replace(request(payment_proof=dict(PROOF)), network="mainnet")
    harness = Harness(current)
    outcome = asyncio.run(
        __import__("validator").validate_checkout(
            current,
            replace(harness.dependencies(), paychan_verifier=verifier),
        )
    )
    assert outcome.validation_errors == ("NETWORK_NOT_TESTNET",)
    assert verifier.requests == []


def test_paychan_proof_is_exact_and_change_sensitive() -> None:
    verifier = FakePaychanVerifier()
    for field, changed in (
        ("channel_id", "E" * 64),
        ("cumulative_drops", "50001"),
        ("signature", "31" * 64),
        ("public_key", "02" + "22" * 32),
    ):
        altered = dict(PROOF)
        altered[field] = changed
        assert _claim_id(altered) != _claim_id(PROOF)

    malformed = dict(PROOF, provider_text="untrusted")
    outcome = _run(malformed, verifier)
    assert outcome.validation_errors == ("PAYCHAN_PROOF_MALFORMED",)
    assert verifier.requests == []

    bad_ed_signature = dict(PROOF, signature="30" * 63)
    outcome = _run(bad_ed_signature, verifier)
    assert outcome.validation_errors == ("PAYCHAN_PROOF_MALFORMED",)
    assert verifier.requests == []

    huge_amount = dict(PROOF, cumulative_drops="9" * 5_000)
    outcome = _run(huge_amount, verifier)
    assert outcome.validation_errors == ("PAYCHAN_PROOF_MALFORMED",)
    assert verifier.requests == []

    oversized_signature = dict(PROOF, signature="30" * 73)
    outcome = _run(oversized_signature, verifier)
    assert outcome.validation_errors == ("PAYCHAN_PROOF_MALFORMED",)
    assert verifier.requests == []


def test_paychan_result_identity_and_shape_are_strict() -> None:
    for override in (
        {"tx_hash": "A" * 64},
        {"validated": False},
        {"engine_result": "tesSUCCESS"},
        {"delivered_currency": "RLUSD"},
        {"delivered_issuer": "rIssuer"},
        {"delivered_value": "1"},
    ):
        verifier = FakePaychanVerifier()
        verifier.result_overrides = override
        outcome = _run(dict(PROOF), verifier)
        assert outcome.http_status == 502
        assert outcome.validation_errors == ("PAYCHAN_RESULT_INVALID",)


def test_paychan_result_binds_trusted_increment_not_cumulative_claim() -> None:
    verifier = FakePaychanVerifier()
    second_claim = dict(PROOF, cumulative_drops="100000")
    outcome = _run(second_claim, verifier)
    assert outcome.validated is True
    assert outcome.tx_hash == _claim_id(second_claim)

    verifier = FakePaychanVerifier()
    verifier.result_overrides = {"delivered_value": "100000"}
    rejected = _run(second_claim, verifier)
    assert rejected.validation_errors == ("PAYCHAN_RESULT_INVALID",)


def test_real_paychan_runtime_accepts_exact_increment_and_rejects_under_or_over() -> None:
    def run_with(cumulative_drops: str):
        proof = {
            "type": "xrpl_paychan_claim",
            "channel_id": CHANNEL,
            "cumulative_drops": cumulative_drops,
            "signature": SIGNATURE,
            "public_key": PUBLIC_KEY,
        }
        current = request(payment_proof=proof)
        harness = Harness(current)
        verifier = paychan_runtime(
            state=paychan_channel(source=PAYER, destination=MERCHANT)
        )
        return asyncio.run(
            __import__("validator").validate_checkout(
                current,
                replace(harness.dependencies(), paychan_verifier=verifier),
            )
        )

    accepted = run_with("50000")
    assert accepted.validated is True
    assert accepted.checks["payment"] == "pass"
    for cumulative_drops in ("1", "49999", "50001"):
        rejected = run_with(cumulative_drops)
        assert rejected.validated is False
        assert rejected.validation_errors == ("PAYCHAN_CLAIM_REJECTED",)


def test_current_paychan_offers_equal_the_trusted_fixed_challenge_increment() -> None:
    store = InMemoryMockChallengeStore(now=lambda: 1_795_000_001)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("merchant.example", 443),
            "path": "/resource",
            "raw_path": b"/resource",
            "query_string": b"",
            "headers": [],
        }
    )
    observed: dict[str, str] = {}
    for merchant_id, seller in MERCHANTS.items():
        item = dict(seller.products[0])
        _, context = store.prepare(seller, item)
        challenge = _challenge(context, seller, item, request)
        paychan = next(
            offer
            for offer in challenge["accepts"]
            if offer["scheme"] == "xrpl-paychan"
        )
        observed[merchant_id] = paychan["amount"]
        assert paychan["amount"] == context.paychan_claim_drops
    assert observed == {
        "risk-oracle": "50000",
        "venue-yield-desk": "50000",
    }


def test_adapter_projects_canonical_paychan_retry_without_decoder_or_validation() -> None:
    context = request().challenge
    current = request(payment_proof=dict(PROOF))
    harness = Harness(current)
    verifier = FakePaychanVerifier()
    runtime = Mm2Runtime(
        replace(
            harness.dependencies(),
            payment_decoder=None,
            paychan_verifier=verifier,
        ),
        InMemoryMockChallengeStore(now=lambda: 1_795_000_001),
    )

    intent_id, identity = asyncio.run(
        paid_retry_key(_adapter_request(context, dict(WIRE_PROOF)), context, runtime)
    )

    assert intent_id == "demo-intent-test"
    assert identity == _claim_id(PROOF)
    assert verifier.retry_proofs == [dict(PROOF)]
    assert verifier.requests == []


def test_adapter_rejects_noncanonical_or_cross_scheme_claim_headers() -> None:
    context = request().challenge
    current = request(payment_proof=dict(PROOF))
    verifier = FakePaychanVerifier()
    runtime = Mm2Runtime(
        replace(Harness(current).dependencies(), paychan_verifier=verifier),
        InMemoryMockChallengeStore(now=lambda: 1_795_000_001),
    )
    for malformed in (
        {
            "channel_id": WIRE_PROOF["channel_id"],
            "scheme": WIRE_PROOF["scheme"],
            "cumulative_drops": WIRE_PROOF["cumulative_drops"],
            "signature": WIRE_PROOF["signature"],
            "public_key": WIRE_PROOF["public_key"],
        },
        dict(PROOF),
        {**WIRE_PROOF, "type": "xrpl_paychan_claim"},
        {**WIRE_PROOF, "provider_text": "must-not-cross-boundary"},
        {**WIRE_PROOF, "scheme": "xrpl_paychan_claim"},
        {
            "scheme": "xrpl-paychan",
            "channelId": WIRE_PROOF["channel_id"],
            "cumulative_drops": WIRE_PROOF["cumulative_drops"],
            "signature": WIRE_PROOF["signature"],
            "public_key": WIRE_PROOF["public_key"],
        },
        {
            "scheme": "xrpl-paychan",
            "channel_id": WIRE_PROOF["channel_id"],
            "cumulativeDrops": WIRE_PROOF["cumulative_drops"],
            "signature": WIRE_PROOF["signature"],
            "publicKey": WIRE_PROOF["public_key"],
        },
    ):
        with pytest.raises(AdapterFailure) as caught:
            asyncio.run(
                paid_retry_key(_adapter_request(context, malformed), context, runtime)
            )
        assert getattr(caught.value, "code", None) == "PAYMENT_HEADER_INVALID"
    assert verifier.retry_proofs == []


def test_adapter_rejects_oversized_header_before_json_parse(monkeypatch) -> None:
    context = request().challenge
    request_scope = _adapter_request(context, dict(WIRE_PROOF)).scope
    oversized = base64.b64encode(
        json.dumps(
            {**PROOF, "provider_text": "x" * 30_000},
            separators=(",", ":"),
        ).encode()
    ).decode()

    def unexpected_parse(_value):
        raise AssertionError("oversized payment header reached JSON parsing")

    monkeypatch.setattr(adapter_base.json, "loads", unexpected_parse)
    with pytest.raises(AdapterFailure) as caught:
        adapter_base._decode_payment_signature(
            oversized,
            request=Request(request_scope),
            context=context,
        )
    assert caught.value.code == "PAYMENT_HEADER_INVALID"


def test_adapter_exact_retry_projection_is_unchanged() -> None:
    context = request().challenge
    current = request()
    harness = Harness(current)
    verifier = FakePaychanVerifier()
    runtime = Mm2Runtime(
        replace(harness.dependencies(), paychan_verifier=verifier),
        InMemoryMockChallengeStore(now=lambda: 1_795_000_001),
    )
    intent_id, identity = asyncio.run(
        paid_retry_key(
            _adapter_request(context, {"type": "xrpl_exact", "tx_blob": "120000"}, exact=True),
            context,
            runtime,
        )
    )
    assert intent_id == "demo-intent-test"
    assert identity == harness.payment.tx_hash
    assert verifier.retry_proofs == []


def test_completed_paychan_retry_recovers_without_second_validation() -> None:
    async def scenario() -> None:
        proof = dict(PROOF)
        store = InMemoryMockChallengeStore(now=lambda: 1_795_000_001)
        seller = MERCHANTS["venue-yield-desk"]
        _, context = store.prepare(seller, dict(seller.products[0]))
        await store.publish(context)
        current = request(challenge=context, payment_proof=proof)
        harness = Harness(current)
        verifier = FakePaychanVerifier()
        runtime = Mm2Runtime(
            replace(harness.dependencies(), paychan_verifier=verifier), store
        )
        prior = merchant_app.app.state.mm2_runtime
        merchant_app.app.state.mm2_runtime = runtime
        try:
            http_request = _adapter_request(context, _wire_proof(proof))
            _, outcome, cached, lease = await _validate_acquired_paid_request(
                http_request,
                context.merchant_id,
                context.sku,
                context.state_id,
            )
            assert outcome is not None and outcome.validated
            assert [event.stage for event in outcome.events] == [
                "wba",
                "intent",
                "credential",
                "payment",
            ]
            assert dict(verifier.requests[0].payment_proof or {}) == dict(PROOF)
            assert cached is None and lease is not None
            result = {"data": {"schema_id": "test"}}
            await store.checkpoint(lease, result)
            await store.complete(
                context.state_id,
                outcome.intent_id,
                outcome.tx_hash or "",
                result,
                lease.owner_token,
            )
            _, second_outcome, recovered, second_lease = (
                await _validate_acquired_paid_request(
                    _adapter_request(context, _wire_proof(proof)),
                    context.merchant_id,
                    context.sku,
                    context.state_id,
                )
            )
            assert second_outcome is None and second_lease is None
            assert recovered == result
            assert len(verifier.requests) == 1
        finally:
            merchant_app.app.state.mm2_runtime = prior

    asyncio.run(scenario())


def test_concurrent_paychan_retry_is_fenced_before_second_validation() -> None:
    class BlockingVerifier(FakePaychanVerifier):
        def __init__(self) -> None:
            super().__init__()
            self.entered = asyncio.Event()
            self.release = asyncio.Event()

        async def validate_claim(self, current, *, credentialed_payer):
            self.entered.set()
            await self.release.wait()
            return await super().validate_claim(
                current, credentialed_payer=credentialed_payer
            )

    async def scenario() -> None:
        proof = dict(PROOF)
        store = InMemoryMockChallengeStore(now=lambda: 1_795_000_001)
        seller = MERCHANTS["venue-yield-desk"]
        _, context = store.prepare(seller, dict(seller.products[0]))
        await store.publish(context)
        current = request(challenge=context, payment_proof=proof)
        verifier = BlockingVerifier()
        runtime = Mm2Runtime(
            replace(Harness(current).dependencies(), paychan_verifier=verifier), store
        )
        prior = merchant_app.app.state.mm2_runtime
        merchant_app.app.state.mm2_runtime = runtime
        first: asyncio.Task | None = None
        try:
            first = asyncio.create_task(
                _validate_acquired_paid_request(
                    _adapter_request(context, _wire_proof(proof)),
                    context.merchant_id,
                    context.sku,
                    context.state_id,
                )
            )
            await verifier.entered.wait()
            with pytest.raises(ChallengeStateError) as competing:
                await _validate_acquired_paid_request(
                    _adapter_request(context, _wire_proof(proof)),
                    context.merchant_id,
                    context.sku,
                    context.state_id,
                )
            assert competing.value.code == "CHALLENGE_STATE_IN_FLIGHT"
            assert len(verifier.requests) == 0
            verifier.release.set()
            _, outcome, _, _ = await first
            assert outcome is not None and outcome.validated
            assert len(verifier.requests) == 1
        finally:
            verifier.release.set()
            if first is not None:
                await asyncio.gather(first, return_exceptions=True)
            merchant_app.app.state.mm2_runtime = prior

    asyncio.run(scenario())


def test_paychan_verifier_exception_cannot_turn_rejection_into_success_status() -> None:
    class UnsafeStatusVerifier(FakePaychanVerifier):
        async def validate_claim(self, current, *, credentialed_payer):
            failure = RuntimeError("provider detail must not escape")
            failure.http_status = 200  # type: ignore[attr-defined]
            raise failure

    outcome = _run(dict(PROOF), UnsafeStatusVerifier())
    assert outcome.http_status == 402
    assert outcome.validation_errors == ("PAYCHAN_CLAIM_REJECTED",)


def test_exact_payment_regression_remains_unchanged() -> None:
    current = request()
    harness = Harness(current)
    outcome = asyncio.run(
        __import__("validator").validate_checkout(current, harness.dependencies())
    )
    assert outcome.validated is True
    assert outcome.tx_hash == harness.payment.tx_hash
    assert harness.transport.calls == 1
