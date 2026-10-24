from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import hashlib
import json
import threading
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import Request
from fastapi.testclient import TestClient

import app.main as merchant_app
from app.events import EventRing
from app.validator.base import (
    AdapterFailure,
    InMemoryMockChallengeStore,
    Mm2Runtime,
    _kernel_request,
)
from validator import (
    CredentialRecord,
    DecodedPayment,
    DirectoryDocument,
    DirectoryFetchPolicy,
    InMemoryAtomicNonceStore,
    MerchantValidationRequest,
    PaymentResult,
    SettlementAsset,
    ValidatorDependencies,
    ViVerification,
)
from validator.context import ChallengeContext, WbaState
from validator.credential import RIPPLE_EPOCH_UNIX_OFFSET
from validator.vi import checkout_digest


NOW = 1_795_000_001
PAYER = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"
ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
CREDENTIAL_TYPE = "4150344D2D4167656E74"
CREDENTIAL_ID = "A" * 64
TX_HASH = "B" * 64
WBA_ORIGIN = "https://harbor.example"
WBA_DIRECTORY_URL = (
    f"{WBA_ORIGIN}/.well-known/http-message-signatures-directory"
)
RESOURCE_PATH = "/m/venue-yield-desk/resource/yield-report"
VI_L1 = "public-l1.presentation"
VI_L2 = "public-l2.presentation"
VI_L3B = "public-l3b.compact-presentation"
MH4_FIXTURE_PATH = (
    Path(__file__).parents[1]
    / "validator"
    / "tests"
    / "fixtures"
    / "ap4m-mh4-mm2-v1.json"
)


def _base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _base64url_json(value: object) -> str:
    return _base64url(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")
    )


def _payment_envelope(challenge: dict[str, object]) -> dict[str, object]:
    accepts = challenge.get("accepts")
    assert isinstance(accepts, list) and accepts
    return {
        "x402Version": 2,
        "resource": challenge["resource"],
        "accepted": accepts[0],
        "payload": {"signedTxBlob": "120000"},
    }


def _payment_signature(challenge: dict[str, object]) -> str:
    """Emit the exact padded-standard-base64 t54/MH4 payment envelope."""

    envelope = _payment_envelope(challenge)
    raw = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def _intent(context: ChallengeContext) -> dict[str, object]:
    amount = f"{context.price_usd_cents // 100}.{context.price_usd_cents % 100:02d}"
    return {
        "intentId": "demo-intent-http-adapter",
        "intentSummary": "Buy the deterministic mock yield report",
        "intentStatus": "ACTIVE",
        "orders": [
            {
                "orderId": "order-http-adapter",
                "orderExecutionType": "DEFERRED",
                "orderExpiry": NOW + 300,
                "orderTotalAmount": {"amount": amount, "currency": "USD"},
                "items": [
                    {
                        "itemId": context.sku,
                        "itemName": "Venue yield report",
                        "itemUnitPrice": {"amount": amount, "currency": "USD"},
                        "itemQuantity": 1,
                        "itemDeliveryMethod": "DIGITAL",
                    }
                ],
                "merchants": [
                    {
                        "srcDpaId": context.src_dpa_id,
                        "merchantName": context.merchant_name,
                    }
                ],
            }
        ],
    }


def _payment_proof() -> dict[str, object]:
    return {
        "type": "xrpl_exact",
        "tx_blob": "120000",
    }


class EphemeralWbaSigner:
    """Test-only signer. Its private key is generated and retained in memory."""

    def __init__(self) -> None:
        self._private_key = Ed25519PrivateKey.generate()
        public = self._private_key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
        self.public_x = _base64url(public)
        jwk = json.dumps(
            {"crv": "Ed25519", "kty": "OKP", "x": self.public_x},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        self.kid = _base64url(hashlib.sha256(jwk).digest())

    def headers(self, path: str, *, nonce_seed: int) -> dict[str, str]:
        nonce = _base64url(
            bytes((index + nonce_seed) % 256 for index in range(64))
        )
        parameters = (
            '("@authority" "@method" "@path" '
            '"signature-agent";key="sig1")'
            f";created={NOW};expires={NOW + 60}"
            f';nonce="{nonce}";keyid="{self.kid}"'
            ';alg="ed25519";tag="web-bot-auth"'
        )
        signature_base = "\n".join(
            (
                '"@authority": testserver',
                '"@method": GET',
                f'"@path": {path}',
                f'"signature-agent";key="sig1": "{WBA_ORIGIN}"',
                f'"@signature-params": {parameters}',
            )
        ).encode("ascii")
        signature = base64.b64encode(self._private_key.sign(signature_base)).decode(
            "ascii"
        )
        return {
            "Signature-Agent": f'sig1="{WBA_ORIGIN}"',
            "Signature-Input": f"sig1={parameters}",
            "Signature": f"sig1=:{signature}:",
        }

    def directory(self) -> DirectoryDocument:
        body: dict[str, object] = {
            "keys": [
                {
                    "kty": "OKP",
                    "crv": "Ed25519",
                    "x": self.public_x,
                    "kid": self.kid,
                    "use": "sig",
                }
            ],
            "xrpl_credential": {
                "issuer": ISSUER,
                "credential_type": "AP4M-Agent",
                "subject": PAYER,
            },
        }
        size = len(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
        return DirectoryDocument(
            body=body,
            final_url=WBA_DIRECTORY_URL,
            redirected=False,
            size_bytes=size,
            status_code=200,
            media_type="application/http-message-signatures-directory+json",
            cache_control="public, max-age=300",
        )


class FakeLedger:
    def __init__(self) -> None:
        self.record = CredentialRecord(
            credential_id=CREDENTIAL_ID,
            issuer=ISSUER,
            credential_type=CREDENTIAL_TYPE,
            subject=PAYER,
            accepted=True,
            expiration_ripple=NOW + 600 - RIPPLE_EPOCH_UNIX_OFFSET,
        )

    async def read_credential(self, credential_id: str) -> CredentialRecord:
        assert credential_id == CREDENTIAL_ID
        return self.record

    async def channel_source(self, channel_id: str) -> str:
        raise AssertionError("the exact-payment adapter must not read a payment channel")

    async def accepted_subject_credential(
        self, subject: str, issuer: str, credential_type: str
    ) -> CredentialRecord | None:
        raise AssertionError("the exact-payment adapter must use the supplied credential")


class FakeTransport:
    def __init__(self) -> None:
        self.calls = 0
        self.requests: list[MerchantValidationRequest] = []
        self.hold = False
        self.entered = threading.Event()
        self.release_gate: asyncio.Event | None = None

    async def validate_exact(
        self, payment: DecodedPayment, request: MerchantValidationRequest
    ) -> PaymentResult:
        self.calls += 1
        self.requests.append(request)
        if self.hold:
            self.release_gate = asyncio.Event()
            self.entered.set()
            await self.release_gate.wait()
        return PaymentResult(
            tx_hash=payment.tx_hash,
            validated=True,
            engine_result="tesSUCCESS",
            delivered_currency=payment.currency,
            delivered_issuer=payment.issuer,
            delivered_value=payment.value,
        )


class FakeViVerifier:
    def __init__(self) -> None:
        self.result: ViVerification | None = None
        self.chains: list[dict[str, object]] = []

    async def __call__(
        self,
        chain: dict[str, object],
        current: MerchantValidationRequest,
    ) -> ViVerification:
        self.chains.append(dict(chain))
        if self.result is None:
            raise AssertionError("test must bind VI output to the server challenge")
        return self.result


@dataclass
class HttpHarness:
    signer: EphemeralWbaSigner
    store: InMemoryMockChallengeStore
    vi: FakeViVerifier
    transport: FakeTransport
    ledger: FakeLedger
    challenge_body: dict[str, object] | None = None

    async def load_directory(
        self, url: str, policy: DirectoryFetchPolicy
    ) -> DirectoryDocument:
        assert url == WBA_DIRECTORY_URL
        assert policy == DirectoryFetchPolicy()
        return self.signer.directory()

    async def decode_payment(self, tx_blob: str) -> DecodedPayment:
        assert tx_blob == "120000"
        assert self._payment is not None
        return self._payment

    _payment: DecodedPayment | None = None

    def bind_server_challenge(
        self,
        context: ChallengeContext,
        *,
        intent: dict[str, object],
        wba_headers: dict[str, str],
        checkout_hash_override: str | None = None,
    ) -> None:
        request = MerchantValidationRequest(
            challenge=context,
            network="testnet",
            intent=intent,
            vi_chain={
                "version": "vi-v0.1",
                "l1": VI_L1,
                "l2": VI_L2,
                "l3b": VI_L3B,
            },
            payment_proof=_payment_proof(),
            method="GET",
            authority="testserver",
            path=RESOURCE_PATH,
            wba={name.lower(): value for name, value in wba_headers.items()},
        )
        digest = checkout_digest(request)
        self.vi.result = ViVerification(
            signatures_valid=True,
            l1_l2_bound=True,
            l2_l3_bound=True,
            l1_issuer=ISSUER,
            owner="rMockOwner",
            budget_account="rMockBudget",
            payer=PAYER,
            of_verified=True,
            of_owner_name_hash="1" * 64,
            of_customer_ref="2" * 64,
            raw_of_identifiers_present=False,
            allowed_payees=(context.merchant_id,),
            allowed_merchants=(context.merchant_id,),
            allowed_skus=(context.sku,),
            per_payment_max_usd_cents=context.price_usd_cents,
            constraint_currency="USD",
            recurrence="ON_DEMAND",
            expires_at=NOW + 600,
            checkout_hash=checkout_hash_override or digest,
        )
        self._payment = DecodedPayment(
            transaction_type="Payment",
            account=PAYER,
            destination=context.merchant_address,
            currency=context.settlement.code,
            issuer=context.settlement.issuer,
            value=context.settlement.value,
            credential_ids=(CREDENTIAL_ID,),
            tx_hash=TX_HASH,
            flags=context.allowed_payment_flags,
            network_id=context.network_id,
            source_tag=context.source_tag,
            destination_tag=context.destination_tag,
            invoice_id=hashlib.sha256(context.invoice_id.encode("utf-8"))
            .hexdigest()
            .upper(),
            memos=(
                f"ap4m/{intent['intentId']}/{context.l3a_digest.lower()}",
            ),
            last_ledger_sequence=context.current_ledger_index + 1,
            fee_drops="1",
            unknown_fields=(),
        )


@pytest.fixture
def http_harness(monkeypatch: pytest.MonkeyPatch):
    signer = EphemeralWbaSigner()
    store = InMemoryMockChallengeStore(now=lambda: NOW, ttl_seconds=300, max_entries=1)
    vi = FakeViVerifier()
    transport = FakeTransport()
    ledger = FakeLedger()
    harness = HttpHarness(signer, store, vi, transport, ledger)
    dependencies = ValidatorDependencies(
        now=lambda: NOW,
        identity_mode="required",
        payment_mode="mock",
        expected_wba_origin=WBA_ORIGIN,
        expected_wba_tag="web-bot-auth",
        accepted_wba_subject=PAYER,
        trusted_l1_issuer=ISSUER,
        trusted_credential_issuer=ISSUER,
        credential_type_hex=CREDENTIAL_TYPE,
        directory_loader=harness.load_directory,
        vi_verifier=vi,  # type: ignore[arg-type]
        payment_decoder=harness.decode_payment,
        ledger_reader=ledger,
        payment_transport=transport,
        nonce_store=InMemoryAtomicNonceStore(),
        wba_state=WbaState(),
    )
    monkeypatch.setattr(merchant_app, "events", EventRing())
    monkeypatch.setattr(
        merchant_app.app.state,
        "mm2_runtime",
        Mm2Runtime(dependencies, store),
        raising=False,
    )
    with TestClient(merchant_app.app) as client:
        yield client, harness


def _issue_challenge(
    client: TestClient, harness: HttpHarness, *, nonce_seed: int = 1
) -> tuple[str, ChallengeContext]:
    response = client.get(
        RESOURCE_PATH,
        headers=harness.signer.headers(RESOURCE_PATH, nonce_seed=nonce_seed),
    )
    assert response.status_code == 402
    challenge_body = response.json()
    harness.challenge_body = challenge_body
    token = response.headers["X-AP4M-Challenge-State"]
    assert challenge_body["extensions"]["ap4m"]["challengeState"] == token
    encoded_challenge = response.headers["PAYMENT-REQUIRED"]
    decoded_challenge = base64.b64decode(encoded_challenge, validate=True)
    assert base64.b64encode(decoded_challenge).decode("ascii") == encoded_challenge
    assert json.loads(decoded_challenge) == challenge_body
    assert len(token) == 43 and all(
        character.isalnum() or character in "_-" for character in token
    )
    context = asyncio.run(harness.store.get(token))
    return token, context


def _paid_headers(
    harness: HttpHarness,
    token: str,
    context: ChallengeContext,
    *,
    nonce_seed: int = 2,
    invalid_checkout_hash: bool = False,
) -> dict[str, str]:
    intent = _intent(context)
    wba_headers = harness.signer.headers(RESOURCE_PATH, nonce_seed=nonce_seed)
    harness.bind_server_challenge(
        context,
        intent=intent,
        wba_headers=wba_headers,
        checkout_hash_override="f" * 64 if invalid_checkout_hash else None,
    )
    assert harness.challenge_body is not None
    return {
        **wba_headers,
        "X-AP4M-Challenge-State": token,
        "X-Mastercard-Intent": _base64url_json(intent),
        "X-VI-L1": VI_L1,
        "X-VI-L2": VI_L2,
        "X-VI-L3B": VI_L3B,
        "PAYMENT-SIGNATURE": _payment_signature(harness.challenge_body),
    }


def test_signed_challenge_and_paid_retry_use_typed_server_state(
    http_harness,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)

    response = client.get(RESOURCE_PATH, headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["data"]["schema_id"] == "yield_report_v1"
    assert body["intent_validation"] == {
        "intentId": "demo-intent-http-adapter",
        "validated": True,
        "checks": {
            "agent_identity": "pass",
            "intent": "pass",
            "credential": "pass",
            "payment": "pass",
        },
        "validation_errors": [],
    }
    assert harness.transport.calls == 1
    kernel_events = [
        event
        for event in merchant_app.events.snapshot()
        if event.get("intent_id") == "demo-intent-http-adapter"
        and event["kind"] in {"wba", "intent", "credential", "payment"}
    ]
    assert [event["kind"] for event in kernel_events] == [
        "wba",
        "intent",
        "credential",
        "payment",
    ]
    assert harness.vi.chains == [
        {"version": "vi-v0.1", "l1": VI_L1, "l2": VI_L2, "l3b": VI_L3B}
    ]
    serialized = response.text
    for secretish in (
        headers["X-Mastercard-Intent"],
        headers["X-VI-L1"],
        headers["X-VI-L2"],
        headers["X-VI-L3B"],
        headers["PAYMENT-SIGNATURE"],
        headers["Signature"],
    ):
        assert secretish not in serialized


def test_exact_completed_retry_recovers_without_resettlement(http_harness) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)

    first = client.get(RESOURCE_PATH, headers=headers)
    recovered = client.get(RESOURCE_PATH, headers=headers)

    assert first.status_code == recovered.status_code == 200
    assert recovered.json() == first.json()
    assert harness.transport.calls == 1
    assert asyncio.run(harness.store.completed_context(token)) == context
    kernel_events = [
        event
        for event in merchant_app.events.snapshot()
        if event.get("intent_id") == "demo-intent-http-adapter"
        and event["kind"] in {"wba", "intent", "credential", "payment"}
    ]
    assert [event["kind"] for event in kernel_events] == [
        "wba",
        "intent",
        "credential",
        "payment",
    ]


def test_completed_retry_rejects_intent_or_payment_hash_mismatch(
    http_harness,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)
    accepted = client.get(RESOURCE_PATH, headers=headers)
    assert accepted.status_code == 200

    changed_intent = _intent(context)
    changed_intent["intentId"] = "demo-intent-recovery-mismatch"
    wrong_intent_headers = {
        **headers,
        "X-Mastercard-Intent": _base64url_json(changed_intent),
    }
    wrong_intent = client.get(RESOURCE_PATH, headers=wrong_intent_headers)
    assert wrong_intent.status_code == 400
    assert wrong_intent.json()["error"] == "CHALLENGE_REPLAY_MISMATCH"

    assert harness._payment is not None
    harness._payment = replace(harness._payment, tx_hash="D" * 64)
    wrong_hash = client.get(RESOURCE_PATH, headers=headers)
    assert wrong_hash.status_code == 400
    assert wrong_hash.json()["error"] == "CHALLENGE_REPLAY_MISMATCH"
    assert harness.transport.calls == 1


def test_crash_after_validated_checkpoint_recovers_without_resettlement(
    http_harness,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)
    original_complete = harness.store.complete

    async def crash_before_completion(*_args, **_kwargs) -> None:
        raise RuntimeError("injected crash after validated checkpoint")

    harness.store.complete = crash_before_completion  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="injected crash"):
        client.get(RESOURCE_PATH, headers=headers)
    assert harness.transport.calls == 1

    harness.store.complete = original_complete  # type: ignore[method-assign]
    harness.store.now = lambda: NOW + harness.store.lease_seconds
    recovered = client.get(RESOURCE_PATH, headers=headers)

    assert recovered.status_code == 200
    assert recovered.json()["intent_validation"]["validated"] is True
    assert harness.transport.calls == 1
    assert asyncio.run(harness.store.completed_context(token)) == context


@pytest.mark.parametrize(
    "duplicate_name",
    [
        "Signature-Agent",
        "Signature-Input",
        "Signature",
        "X-AP4M-Challenge-State",
        "X-Mastercard-Intent",
        "X-VI-L1",
        "X-VI-L2",
        "X-VI-L3B",
        "PAYMENT-SIGNATURE",
    ],
)
def test_duplicate_protected_headers_are_rejected_before_validation(
    http_harness, duplicate_name: str
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)
    duplicate_value = headers.pop(duplicate_name)

    response = client.get(
        RESOURCE_PATH,
        headers=[
            *headers.items(),
            (duplicate_name, duplicate_value),
            (duplicate_name, duplicate_value),
        ],
    )

    assert response.status_code == 400
    assert "data" not in response.json()
    assert harness.transport.calls == 0
    assert duplicate_value not in response.text


def test_challenge_state_is_scoped_server_side_and_cannot_be_retargeted(
    http_harness,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)
    other_path = "/m/risk-oracle/resource/risk-score"
    headers.update(harness.signer.headers(other_path, nonce_seed=3))

    response = client.get(other_path, headers=headers)

    assert response.status_code == 400
    assert "data" not in response.json()
    assert harness.transport.calls == 0


def test_kernel_failure_emits_all_stages_without_transport_or_paid_data(
    http_harness,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(
        harness,
        token,
        context,
        invalid_checkout_hash=True,
    )

    response = client.get(RESOURCE_PATH, headers=headers)

    assert response.status_code == 400
    body = response.json()
    assert "data" not in body
    assert body["intent_validation"]["validated"] is False
    assert body["intent_validation"]["validation_errors"] == [
        "VI_CHECKOUT_MISMATCH"
    ]
    assert harness.transport.calls == 0
    relevant = [
        event
        for event in merchant_app.events.snapshot()
        if event.get("intent_id") == "demo-intent-http-adapter"
    ]
    assert [event["kind"] for event in relevant] == [
        "wba",
        "intent",
        "credential",
        "payment",
    ]
    assert [event["result"] for event in relevant] == [
        "pass",
        "fail",
        "fail",
        "fail",
    ]
    for raw in (
        headers["X-Mastercard-Intent"],
        headers["X-VI-L3B"],
        headers["PAYMENT-SIGNATURE"],
        headers["Signature"],
    ):
        assert raw not in response.text


def test_oversized_vi_header_is_rejected_before_any_payment_transport(
    http_harness,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)
    headers["X-VI-L2"] = "x" * 20_000

    response = client.get(RESOURCE_PATH, headers=headers)

    assert response.status_code == 400
    assert "data" not in response.json()
    assert harness.transport.calls == 0


@pytest.mark.parametrize("noncanonical", ["whitespace", "reordered", "duplicate"])
def test_payment_signature_requires_exact_canonical_json_bytes(
    http_harness,
    noncanonical: str,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    headers = _paid_headers(harness, token, context)
    assert harness.challenge_body is not None
    envelope = _payment_envelope(harness.challenge_body)
    if noncanonical == "whitespace":
        raw = json.dumps(envelope, indent=1).encode("utf-8")
    elif noncanonical == "reordered":
        raw = json.dumps(
            {
                "resource": envelope["resource"],
                "x402Version": envelope["x402Version"],
                "accepted": envelope["accepted"],
                "payload": envelope["payload"],
            },
            separators=(",", ":"),
        ).encode("utf-8")
    else:
        canonical = json.dumps(envelope, separators=(",", ":"))
        raw = canonical.replace(
            '"x402Version":2,',
            '"x402Version":2,"x402Version":2,',
            1,
        ).encode("utf-8")
    encoded = base64.b64encode(raw).decode("ascii")
    headers["PAYMENT-SIGNATURE"] = encoded

    response = client.get(RESOURCE_PATH, headers=headers)

    assert response.status_code == 400
    assert response.json()["error"] == "PAYMENT_HEADER_INVALID"
    assert "data" not in response.json()
    assert harness.transport.calls == 0
    assert encoded not in response.text


def test_legacy_x_payment_header_never_enters_the_paid_retry_path(
    http_harness,
) -> None:
    client, harness = http_harness
    legacy_proof = _base64url_json(_payment_proof())
    headers = {
        **harness.signer.headers(RESOURCE_PATH, nonce_seed=4),
        "X-PAYMENT": legacy_proof,
    }

    response = client.get(RESOURCE_PATH, headers=headers)

    assert response.status_code == 402
    assert response.json()["error"] == "payment_required"
    assert "data" not in response.json()
    assert harness.transport.calls == 0
    assert legacy_proof not in response.text


def test_concurrent_same_state_retry_invokes_transport_once(
    http_harness,
) -> None:
    client, harness = http_harness
    token, context = _issue_challenge(client, harness)
    first_headers = _paid_headers(harness, token, context, nonce_seed=10)
    second_headers = _paid_headers(harness, token, context, nonce_seed=11)
    harness.transport.hold = True

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(client.get, RESOURCE_PATH, headers=first_headers)
        assert harness.transport.entered.wait(timeout=2)
        try:
            competing = client.get(RESOURCE_PATH, headers=second_headers)
            assert competing.status_code == 400
            assert competing.json()["error"] == "CHALLENGE_STATE_IN_FLIGHT"
            assert "data" not in competing.json()
            assert harness.transport.calls == 1
        finally:
            assert harness.transport.release_gate is not None
            client.portal.call(harness.transport.release_gate.set)
        accepted = first.result(timeout=2)

    assert accepted.status_code == 200
    assert accepted.json()["intent_validation"]["validated"] is True
    assert harness.transport.calls == 1


def test_invalid_wba_cannot_evict_a_valid_challenge_from_full_store(
    http_harness,
) -> None:
    client, harness = http_harness
    token, original = _issue_challenge(client, harness)
    invalid_signature = harness.signer.headers(
        "/wrong-signed-path",
        nonce_seed=12,
    )

    rejected = client.get(RESOURCE_PATH, headers=invalid_signature)

    assert rejected.status_code == 401
    assert rejected.json()["error"] == "WBA_SIGNATURE_INVALID"
    retained = asyncio.run(harness.store.get(token))
    assert retained == original
    assert list(harness.store._entries) == [token]


def _mh4_fixture() -> dict[str, Any]:
    return json.loads(MH4_FIXTURE_PATH.read_text(encoding="utf-8"))


def _mh4_fixture_context(fixture: dict[str, Any]) -> ChallengeContext:
    merchant = fixture["merchant"]
    vi = fixture["vi"]
    challenge = fixture["x402"]["validated_challenge"]
    accepted = challenge["accepted"]
    extra = accepted["extra"]
    return ChallengeContext(
        state_id="A" * 43,
        merchant_id=merchant["id"],
        merchant_name=challenge["resource"]["serviceName"],
        src_dpa_id=fixture["intent"]["orders"][0]["merchants"][0]["srcDpaId"],
        merchant_address=merchant["address"],
        sku=merchant["sku"],
        price_usd_cents=100,
        settlement=SettlementAsset(
            "RLUSD",
            merchant["issuer"],
            accepted["amount"],
        ),
        network_id=1,
        source_tag=extra["sourceTag"],
        destination_tag=extra.get("destinationTag"),
        invoice_id=extra["invoiceId"],
        l3a_digest=vi["l3a_digest"],
        current_ledger_index=10_000,
        max_last_ledger_delta=20,
        max_fee_drops=100,
        resource_description=challenge["resource"]["description"],
    )


def test_public_mh4_fixture_projects_exact_synthetic_adapter_wire() -> None:
    """Exercise only the public wire projection; DEADBEEF is not ledger proof."""

    fixture = _mh4_fixture()
    assert fixture["version"] == "ap4m-mh4-mm2-v1"
    assert fixture["evidence_scope"] == (
        "offline cross-language fixture; no Testnet submission or settlement claim"
    )
    assert fixture["x402"]["synthetic_payment"] == {
        "stand_in": True,
        "ledger_validated": False,
        "label": (
            "synthetic fixture only — invalid as a real signed XRPL transaction "
            "and never submitted"
        ),
        "signed_tx_blob": "DEADBEEF",
        "tx_hash": "C" * 64,
    }

    context = _mh4_fixture_context(fixture)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("merchant.example", 443),
            "raw_path": b"/resource/yield-report",
            "headers": [],
        }
    )
    headers = {
        key.lower(): value
        for key, value in fixture["x402"]["retry_headers"].items()
        if key.lower() != "accept"
    }
    headers["x-ap4m-challenge-state"] = context.state_id

    projected = _kernel_request(request, context, headers)

    assert projected.intent == fixture["intent"]
    assert projected.vi_chain == {
        "version": "vi-v0.1",
        "l1": fixture["vi"]["l1"],
            "l2": fixture["vi"]["l2_presentations"]["merchant"],
        "l3b": fixture["vi"]["l3b"],
    }
    assert projected.payment_proof == {
        "type": "xrpl_exact",
        "tx_blob": "DEADBEEF",
    }
    assert checkout_digest(projected) == fixture["vi"]["checkout_hash"]


def test_public_mh4_fixture_payment_envelope_is_bound_to_server_context() -> None:
    fixture = _mh4_fixture()
    context = _mh4_fixture_context(fixture)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("merchant.example", 443),
            "raw_path": b"/resource/yield-report",
            "headers": [],
        }
    )
    headers = {
        key.lower(): value
        for key, value in fixture["x402"]["retry_headers"].items()
        if key.lower() != "accept"
    }
    headers["x-ap4m-challenge-state"] = context.state_id
    altered = replace(context, merchant_address=PAYER)

    with pytest.raises(AdapterFailure) as failure:
        _kernel_request(request, altered, headers)

    assert failure.value.code == "PAYMENT_REQUIREMENTS_MISMATCH"
