import asyncio
import hashlib
import json
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from validator import (
    ChallengeContext,
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
    validate_checkout,
)
from validator.context import WbaState
from validator.credential import RIPPLE_EPOCH_UNIX_OFFSET, ripple_epoch_to_unix
from validator.vi import checkout_digest
from validator.wba_wire import parse_wba_wire


NOW = 1_795_000_001
PAYER = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"
MERCHANT = "rMerchant"
ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
RLUSD_ISSUER = "rStableIssuer"
CREDENTIAL_TYPE = "4150344D2D4167656E74"
CREDENTIAL_ID = "A" * 64
TX_HASH = "B" * 64
INVOICE_ID = "C" * 64
L3A_DIGEST = "d" * 64
DIRECTORY_ORIGIN = "https://harbor.example"
DIRECTORY_URL = f"{DIRECTORY_ORIGIN}/.well-known/http-message-signatures-directory"
WBA_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "wba-mh6-mm2-v1.json"
WBA_FIXTURE = json.loads(WBA_FIXTURE_PATH.read_text())
WBA_REQUEST_URL = urlsplit(WBA_FIXTURE["request"]["url"])
KEY_ID = WBA_FIXTURE["directory"]["body"]["keys"][0]["kid"]


def intent() -> dict[str, Any]:
    return {
        "intentId": "demo-intent-test",
        "intentSummary": "Buy a yield report",
        "intentStatus": "ACTIVE",
        "orders": [
            {
                "orderId": "order-1",
                "orderExecutionType": "DEFERRED",
                "orderExpiry": NOW + 300,
                "orderTotalAmount": {"amount": "1.00", "currency": "USD"},
                "items": [
                    {
                        "itemId": "yield-report",
                        "itemName": "Venue yield report",
                        "itemUnitPrice": {"amount": "1.00", "currency": "USD"},
                        "itemQuantity": 1,
                        "itemDeliveryMethod": "DIGITAL",
                    }
                ],
                "merchants": [
                    {
                        "srcDpaId": "demo-dpa-venue-yield-desk",
                        "merchantName": "Venue Yield Desk",
                    }
                ],
            }
        ],
    }


def challenge(**changes: Any) -> ChallengeContext:
    values: dict[str, Any] = {
        "state_id": "challenge-state-server-derived",
        "merchant_id": "venue-yield-desk",
        "merchant_name": "Venue Yield Desk",
        "src_dpa_id": "demo-dpa-venue-yield-desk",
        "merchant_address": MERCHANT,
        "sku": "yield-report",
        "price_usd_cents": 100,
        "settlement": SettlementAsset("RLUSD", RLUSD_ISSUER, "1"),
        "network_id": 1,
        "source_tag": 2133,
        "destination_tag": 9001,
        "invoice_id": INVOICE_ID,
        "l3a_digest": L3A_DIGEST,
        "current_ledger_index": 10_000,
        "max_last_ledger_delta": 20,
        "max_fee_drops": 100,
    }
    values.update(changes)
    return ChallengeContext(**values)


def request(**changes: Any) -> MerchantValidationRequest:
    values: dict[str, Any] = {
        "challenge": challenge(),
        "network": "testnet",
        "intent": intent(),
        "vi_chain": {
            "version": "vi-v0.1",
            "l1": "public-l1.presentation",
            "l2": "public-l2.presentation",
            "l3b": "public-l3b.presentation",
        },
        "payment_proof": {
            "type": "xrpl_exact",
            "tx_blob": "120000",
        },
        "expected_owner": "rOwner",
        "expected_budget_account": "rBudget",
        "method": WBA_FIXTURE["request"]["method"],
        "authority": WBA_REQUEST_URL.netloc,
        "path": WBA_REQUEST_URL.path,
    }
    values.update(changes)
    return MerchantValidationRequest(**values)


def wba() -> dict[str, object]:
    return {
        name.lower(): value
        for name, value in deepcopy(WBA_FIXTURE["request"]["headers"]).items()
    }


def directory_body(subject: str = PAYER) -> dict[str, object]:
    body = deepcopy(WBA_FIXTURE["directory"]["body"])
    body["xrpl_credential"]["subject"] = subject
    return body


class FakeLedger:
    def __init__(self) -> None:
        self.record = CredentialRecord(
            CREDENTIAL_ID,
            ISSUER,
            CREDENTIAL_TYPE,
            PAYER,
            True,
            NOW + 600 - RIPPLE_EPOCH_UNIX_OFFSET,
        )

    async def read_credential(self, credential_id: str) -> CredentialRecord:
        return self.record

    async def channel_source(self, channel_id: str) -> str:
        return PAYER

    async def accepted_subject_credential(
        self, subject: str, issuer: str, credential_type: str
    ) -> CredentialRecord | None:
        if (subject, issuer, credential_type) == (PAYER, ISSUER, CREDENTIAL_TYPE):
            return self.record
        return None


class FakeTransport:
    def __init__(self) -> None:
        self.calls = 0
        self.result = PaymentResult(
            TX_HASH,
            True,
            "tesSUCCESS",
            "RLUSD",
            RLUSD_ISSUER,
            "1",
        )

    async def validate_exact(
        self, payment: DecodedPayment, current: MerchantValidationRequest
    ) -> PaymentResult:
        self.calls += 1
        return self.result


class Harness:
    def __init__(self, current: MerchantValidationRequest) -> None:
        self.current = current
        self.ledger = FakeLedger()
        self.transport = FakeTransport()
        self.directory_calls = 0
        self.nonce_store = InMemoryAtomicNonceStore()
        self.state = WbaState()
        self.document = DirectoryDocument(
            directory_body(),
            DIRECTORY_URL,
            False,
            512,
            WBA_FIXTURE["directory"]["status"],
            WBA_FIXTURE["directory"]["content_type"],
            WBA_FIXTURE["directory"]["cache_control"],
        )
        self.vi = ViVerification(
            signatures_valid=True,
            l1_l2_bound=True,
            l2_l3_bound=True,
            l1_issuer=ISSUER,
            owner="rOwner",
            budget_account="rBudget",
            payer=PAYER,
            of_verified=True,
            of_owner_name_hash="1" * 64,
            of_customer_ref="2" * 64,
            raw_of_identifiers_present=False,
            allowed_payees=("venue-yield-desk",),
            allowed_merchants=("venue-yield-desk",),
            allowed_skus=("yield-report",),
            per_payment_max_usd_cents=100,
            constraint_currency="USD",
            recurrence="ON_DEMAND",
            expires_at=NOW + 600,
            checkout_hash=checkout_digest(current),
        )
        self.payment = DecodedPayment(
            transaction_type="Payment",
            account=PAYER,
            destination=MERCHANT,
            currency="RLUSD",
            issuer=RLUSD_ISSUER,
            value="1",
            credential_ids=(CREDENTIAL_ID,),
            tx_hash=TX_HASH,
            flags=0x80000000,
            network_id=1,
            source_tag=2133,
            destination_tag=9001,
            invoice_id=hashlib.sha256(INVOICE_ID.encode()).hexdigest().upper(),
            memos=(f"ap4m/demo-intent-test/{L3A_DIGEST.lower()}",),
            last_ledger_sequence=10_010,
            fee_drops="12",
            unknown_fields=(),
        )

    async def load_directory(
        self, url: str, policy: DirectoryFetchPolicy
    ) -> DirectoryDocument:
        self.directory_calls += 1
        assert url == DIRECTORY_URL
        assert policy.timeout_ms == 2_000
        assert policy.allow_redirects is False
        return self.document

    async def verify_vi(
        self,
        chain: dict[str, object],
        current: MerchantValidationRequest,
    ) -> ViVerification:
        return self.vi

    async def decode(self, blob: str) -> DecodedPayment:
        return self.payment

    def dependencies(
        self,
        *,
        identity_mode: str = "skipped",
        payment_mode: str = "mock",
        allow_live: bool = False,
        accepted_wba_subject: str = PAYER,
        directory_policy: DirectoryFetchPolicy | None = None,
    ) -> ValidatorDependencies:
        return ValidatorDependencies(
            now=lambda: NOW,
            identity_mode=identity_mode,  # type: ignore[arg-type]
            payment_mode=payment_mode,  # type: ignore[arg-type]
            expected_wba_origin=DIRECTORY_ORIGIN,
            expected_wba_tag="web-bot-auth",
            accepted_wba_subject=accepted_wba_subject,
            trusted_l1_issuer=ISSUER,
            trusted_credential_issuer=ISSUER,
            credential_type_hex=CREDENTIAL_TYPE,
            directory_loader=self.load_directory,
            vi_verifier=self.verify_vi,  # type: ignore[arg-type]
            payment_decoder=self.decode,
            ledger_reader=self.ledger,
            payment_transport=self.transport,
            nonce_store=self.nonce_store,
            wba_state=self.state,
            directory_policy=directory_policy or DirectoryFetchPolicy(),
            allow_live=allow_live,
        )


def run(current: MerchantValidationRequest, deps: ValidatorDependencies):
    return asyncio.run(validate_checkout(current, deps))


def test_valid_mock_checkout_separates_usd_authority_from_rlusd_settlement() -> None:
    current = request()
    harness = Harness(current)
    outcome = run(current, harness.dependencies())
    assert outcome.validated is True
    assert outcome.checks == {
        "wba": "skipped",
        "intent": "pass",
        "credential": "pass",
        "payment": "pass",
    }
    assert [event.stage for event in outcome.events] == [
        "wba",
        "intent",
        "credential",
        "payment",
    ]
    assert outcome.events[0].result == "skipped"
    assert outcome.tx_hash == TX_HASH


def test_testnet_payment_may_omit_network_id() -> None:
    current = request()
    harness = Harness(current)
    harness.payment = replace(harness.payment, network_id=None)
    assert run(current, harness.dependencies()).validated is True


def test_valid_required_wba_uses_origin_discovery_and_cache() -> None:
    first = request(wba=wba())
    harness = Harness(first)
    assert run(first, harness.dependencies(identity_mode="required")).validated
    harness.nonce_store = InMemoryAtomicNonceStore()
    second = request(wba=wba())
    assert run(second, harness.dependencies(identity_mode="required")).validated
    assert harness.directory_calls == 1
    assert harness.state.directory_cache[DIRECTORY_URL][0] == NOW + 300


def test_named_check_unsigned_request_is_rejected() -> None:
    current = request(wba=None)
    harness = Harness(current)

    outcome = run(current, harness.dependencies(identity_mode="required"))

    assert outcome.http_status == 401
    assert outcome.validation_errors == ("WBA_REQUIRED",)
    assert harness.transport.calls == 0


def test_public_mh6_fixture_reconstructs_byte_identical_signature_base() -> None:
    assert hashlib.sha256(WBA_FIXTURE_PATH.read_bytes()).hexdigest() == (
        "d66471e7a4c1776e9ea8ef71f6c3f0fb7ec2a03b5c4ba016008bac64d29bcbc8"
    )
    current = request(wba=wba())
    parsed = parse_wba_wire(current.wba, current)
    assert parsed.signature_base.decode() == "\n".join(
        (
            '"@authority": merchant.example',
            '"@method": GET',
            '"@path": /resource/yield-report',
            '"signature-agent";key="sig1": "https://harbor.example"',
            '"@signature-params": '
            '("@authority" "@method" "@path" "signature-agent";key="sig1");'
            'created=1795000000;expires=1795000060;'
            'nonce="AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKiss'
            'LS4vMDEyMzQ1Njc4OTo7PD0-Pw";'
            'keyid="hMpqJ0RLXpBl0y-lbewzCqQ7jgh5SsU7Hulc-r0spg4";'
            'alg="ed25519";tag="web-bot-auth"',
        )
    )


def test_expired_cache_cannot_authenticate_and_failed_refresh_is_non_destructive() -> None:
    current = request(wba=wba())
    harness = Harness(current)
    expired_entry = (NOW, harness.document)
    harness.state.directory_cache[DIRECTORY_URL] = expired_entry
    harness.document = replace(harness.document, status_code=503)
    outcome = run(current, harness.dependencies(identity_mode="required"))
    assert outcome.validation_errors == ("WBA_DIRECTORY_STATUS_INVALID",)
    assert harness.directory_calls == 1
    assert harness.state.directory_cache[DIRECTORY_URL] == expired_entry


def changed_wba(header: str, old: str, new: str) -> dict[str, object]:
    evidence = wba()
    value = evidence[header]
    assert isinstance(value, str) and old in value
    evidence[header] = value.replace(old, new, 1)
    return evidence


def test_atomic_nonce_claim_allows_only_one_concurrent_request() -> None:
    current = request(wba=wba())
    harness = Harness(current)
    deps = harness.dependencies(identity_mode="required")

    async def concurrent():
        return await asyncio.gather(
            validate_checkout(current, deps),
            validate_checkout(current, deps),
        )

    outcomes = asyncio.run(concurrent())
    assert sorted(outcome.validated for outcome in outcomes) == [False, True]
    assert [
        outcome.validation_errors
        for outcome in outcomes
        if not outcome.validated
    ] == [("WBA_REPLAY",)]
    assert harness.transport.calls == 1


@pytest.mark.parametrize(
    ("header", "old", "new", "code"),
    [
        (
            "signature-agent",
            DIRECTORY_ORIGIN,
            f"{DIRECTORY_ORIGIN}/path",
            "WBA_DIRECTORY_MISMATCH",
        ),
        ("signature-agent", "sig1=", "other=", "WBA_LABEL_MISMATCH"),
        ("signature-input", "sig1=", "other=", "WBA_LABEL_MISMATCH"),
        ("signature", "sig1=", "other=", "WBA_LABEL_MISMATCH"),
        ("signature-input", 'key="sig1"', 'key="other"', "WBA_COMPONENTS_INVALID"),
        ("signature-agent", f'"{DIRECTORY_ORIGIN}"', DIRECTORY_ORIGIN, "WBA_MALFORMED"),
        ("signature-input", 'tag="web-bot-auth"', 'tag="agent-payer-auth"', "WBA_TAG_MISMATCH"),
        ("signature-input", 'alg="ed25519"', 'alg="rsa-pss-sha512"', "WBA_ALG_MISMATCH"),
        (
            "signature-input",
            "created=1795000000",
            "created=1795000010",
            "WBA_CREATED_IN_FUTURE",
        ),
        (
            "signature-input",
            "expires=1795000060",
            "expires=1795000001",
            "WBA_EXPIRED",
        ),
        (
            "signature-input",
            "expires=1795000060",
            "expires=1795000059",
            "WBA_EXPIRED",
        ),
        ("signature-input", KEY_ID, "a" * 42, "WBA_KEYID_INVALID"),
        ("signature-input", '"@authority"', '"@scheme"', "WBA_COMPONENTS_INVALID"),
        (
            "signature-input",
            (
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKiss"
                "LS4vMDEyMzQ1Njc4OTo7PD0-Pw"
            ),
            "AA",
            "WBA_NONCE_INVALID",
        ),
    ],
)
def test_wba_wire_policy_failures(
    header: str,
    old: str,
    new: str,
    code: str,
) -> None:
    evidence = changed_wba(header, old, new)
    current = request(wba=evidence)
    outcome = run(current, Harness(current).dependencies(identity_mode="required"))
    assert outcome.http_status == 401
    assert outcome.validation_errors == (code,)


def test_wba_unknown_evidence_fields_fail_closed() -> None:
    evidence = wba()
    evidence["attacker"] = True
    current = request(wba=evidence)
    outcome = run(current, Harness(current).dependencies(identity_mode="required"))
    assert outcome.validation_errors == ("WBA_MALFORMED",)


@pytest.mark.parametrize(
    ("evidence", "code"),
    [
        (changed_wba("signature-agent", "sig1=", "sig1 ="), "WBA_MALFORMED"),
        (
            changed_wba(
                "signature-input",
                'tag="web-bot-auth"',
                'tag="web-bot-auth";extra=1',
            ),
            "WBA_MALFORMED",
        ),
        (changed_wba("signature", "==:", "=:"), "WBA_SIGNATURE_MALFORMED"),
    ],
)
def test_wba_rejects_noncanonical_raw_dictionary_forms(
    evidence: dict[str, object],
    code: str,
) -> None:
    current = request(wba=evidence)
    outcome = run(current, Harness(current).dependencies(identity_mode="required"))
    assert outcome.validation_errors == (code,)


def test_wba_non_object_evidence_fails_closed() -> None:
    current = request(wba=[])  # type: ignore[arg-type]
    outcome = run(current, Harness(current).dependencies(identity_mode="required"))
    assert outcome.validation_errors == ("WBA_MALFORMED",)


@pytest.mark.parametrize(
    ("document_change", "code"),
    [
        ({"redirected": True}, "WBA_DIRECTORY_REDIRECT"),
        ({"final_url": "https://other.example/directory"}, "WBA_DIRECTORY_REDIRECT"),
        ({"size_bytes": 20_000}, "WBA_DIRECTORY_TOO_LARGE"),
        ({"size_bytes": None}, "WBA_DIRECTORY_TOO_LARGE"),
        ({"status_code": 503}, "WBA_DIRECTORY_STATUS_INVALID"),
        ({"status_code": 200.0}, "WBA_DIRECTORY_STATUS_INVALID"),
        ({"media_type": "application/json"}, "WBA_DIRECTORY_MEDIA_TYPE_INVALID"),
        ({"cache_control": "max-age=300"}, "WBA_DIRECTORY_CACHE_INVALID"),
    ],
)
def test_wba_directory_transport_bounds(
    document_change: dict[str, object], code: str
) -> None:
    current = request(wba=wba())
    harness = Harness(current)
    harness.document = replace(harness.document, **document_change)
    outcome = run(current, harness.dependencies(identity_mode="required"))
    assert outcome.validation_errors == (code,)


@pytest.mark.parametrize(
    "unsafe",
    [
        DirectoryFetchPolicy(
            max_bytes=16_384,
            max_keys=4,
            timeout_ms=2_000,
            allow_redirects=True,
        ),
        DirectoryFetchPolicy(max_bytes=16_385),
        DirectoryFetchPolicy(max_keys=5),
        DirectoryFetchPolicy(timeout_ms=2_001),
    ],
)
def test_wba_fetch_policy_is_bounded_and_no_redirect(
    unsafe: DirectoryFetchPolicy,
) -> None:
    current = request(wba=wba())
    harness = Harness(current)
    outcome = run(
        current,
        harness.dependencies(identity_mode="required", directory_policy=unsafe),
    )
    assert outcome.validation_errors == ("WBA_FETCH_POLICY_INVALID",)


def test_wba_directory_credential_must_match_configured_and_payment_payer() -> None:
    current = request(wba=wba())
    harness = Harness(current)
    harness.document = replace(harness.document, body=directory_body("rOther"))
    rejected = run(current, harness.dependencies(identity_mode="required"))
    assert rejected.validation_errors == ("WBA_CREDENTIAL_MISMATCH",)

    harness = Harness(current)
    harness.document = replace(harness.document, body=directory_body("rOther"))
    mismatch = run(
        current,
        harness.dependencies(identity_mode="required", accepted_wba_subject="rOther"),
    )
    assert mismatch.validation_errors == ("WBA_PAYER_MISMATCH",)


def test_wba_directory_kid_must_be_the_public_jwk_thumbprint() -> None:
    current = request(wba=changed_wba("signature-input", KEY_ID, "a" * 43))
    harness = Harness(current)
    body = directory_body()
    body["keys"][0]["kid"] = "a" * 43  # type: ignore[index]
    harness.document = replace(harness.document, body=body)
    outcome = run(current, harness.dependencies(identity_mode="required"))
    assert outcome.validation_errors == ("WBA_DIRECTORY_KEY_INVALID",)


def test_wba_signature_binds_request_target_and_rejects_tampering() -> None:
    current = request(wba=changed_wba("signature", "EG", "FG"))
    invalid_signature = run(
        current,
        Harness(current).dependencies(identity_mode="required"),
    )
    assert invalid_signature.validation_errors == ("WBA_SIGNATURE_INVALID",)

    for change in (
        {"authority": "other.invalid"},
        {"method": "POST"},
        {"path": "/other"},
    ):
        tampered = request(wba=wba(), **change)
        outcome = run(
            tampered,
            Harness(tampered).dependencies(identity_mode="required"),
        )
        assert outcome.validation_errors == ("WBA_SIGNATURE_INVALID",)


def test_wba_directory_rejects_duplicate_key_ids_and_nonstring_credential() -> None:
    current = request(wba=wba())
    harness = Harness(current)
    body = directory_body()
    body["keys"] = [body["keys"][0], dict(body["keys"][0])]  # type: ignore[index]
    harness.document = replace(harness.document, body=body)
    duplicate = run(current, harness.dependencies(identity_mode="required"))
    assert duplicate.validation_errors == ("WBA_DIRECTORY_KEY_INVALID",)

    harness = Harness(current)
    body = directory_body()
    body["xrpl_credential"]["subject"] = 7  # type: ignore[index]
    harness.document = replace(harness.document, body=body)
    malformed = run(current, harness.dependencies(identity_mode="required"))
    assert malformed.validation_errors == ("WBA_CREDENTIAL_INVALID",)


def _intent_change(path: tuple[object, ...], value: object) -> dict[str, Any]:
    changed = deepcopy(intent())
    node: Any = changed
    for part in path[:-1]:
        node = node[part]
    node[path[-1]] = value
    return changed


@pytest.mark.parametrize(
    ("path", "value", "code"),
    [
        (("intentStatus",), "REVOKED", "INTENT_NOT_ACTIVE"),
        (("orders", 0, "orderExecutionType"), "IMMEDIATE", "INTENT_NOT_DEFERRED"),
        (("orders", 0, "orderExpiry"), NOW, "INTENT_EXPIRED"),
        (("orders", 0, "orderTotalAmount", "currency"), "RLUSD", "INTENT_CURRENCY_MISMATCH"),
        (("orders", 0, "orderTotalAmount", "amount"), "0.99", "INTENT_TOTAL_TOO_LOW"),
        (("orders", 0, "orderTotalAmount", "amount"), "1.001", "INTENT_TOTAL_INVALID"),
        (("orders", 0, "items", 0, "itemId"), "wrong", "INTENT_ITEM_MISMATCH"),
        (("orders", 0, "items", 0, "itemQuantity"), True, "INTENT_ITEM_MISMATCH"),
        (("orders", 0, "items", 0, "itemUnitPrice", "amount"), "2", "INTENT_ITEM_MISMATCH"),
        (("orders", 0, "merchants", 0, "srcDpaId"), "wrong", "INTENT_MERCHANT_MISMATCH"),
    ],
)
def test_intent_failure_matrix(path: tuple[object, ...], value: object, code: str) -> None:
    current = request(intent=_intent_change(path, value))
    harness = Harness(current)
    outcome = run(current, harness.dependencies())
    assert outcome.validation_errors == (code,)
    assert harness.transport.calls == 0


def test_untrusted_intent_id_is_never_copied_into_events() -> None:
    hostile = "demo-intent-" + "X" * 5_000
    current = request(intent=_intent_change(("intentId",), hostile))
    outcome = run(current, Harness(current).dependencies())
    assert outcome.validation_errors == ("INTENT_ID_INVALID",)
    assert outcome.intent_id == "demo-intent-unverified"
    assert hostile not in repr(outcome)


def test_non_object_intent_is_rejected_without_event_crash() -> None:
    current = request(intent=[])  # type: ignore[arg-type]
    outcome = run(current, Harness(request()).dependencies())
    assert outcome.intent_id == "demo-intent-unverified"
    assert outcome.validation_errors == ("INTENT_FIELDS_INVALID",)


def test_named_check_tampered_intent_is_rejected_by_checkout_binding() -> None:
    tampered = intent()
    current = request(intent=tampered)
    harness = Harness(current)
    tampered["intentSummary"] = "tampered after the VI was minted"

    outcome = run(current, harness.dependencies())

    assert outcome.validation_errors == ("VI_CHECKOUT_MISMATCH",)
    assert harness.transport.calls == 0


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("signatures_valid", False, "VI_SIGNATURE_INVALID"),
        ("signatures_valid", 1, "VI_SIGNATURE_INVALID"),
        ("l1_l2_bound", False, "VI_BINDING_INVALID"),
        ("l1_issuer", "wrong", "VI_ISSUER_UNTRUSTED"),
        ("owner", "wrong", "VI_OWNER_MISMATCH"),
        ("budget_account", "wrong", "VI_BUDGET_MISMATCH"),
        ("payer", "", "VI_PAYER_MISMATCH"),
        ("of_verified", False, "VI_OPEN_FINANCE_UNVERIFIED"),
        ("of_verified", 1, "VI_OPEN_FINANCE_UNVERIFIED"),
        ("raw_of_identifiers_present", True, "VI_OPEN_FINANCE_RAW_ID"),
        ("raw_of_identifiers_present", 0, "VI_OPEN_FINANCE_RAW_ID"),
        ("of_customer_ref", "raw-customer", "VI_OPEN_FINANCE_HASH_INVALID"),
        ("of_owner_name_hash", None, "VI_OPEN_FINANCE_HASH_INVALID"),
        ("allowed_payees", (MERCHANT,), "VI_PAYEE_BLOCKED"),
        ("allowed_payees", "venue-yield-desk", "VI_PAYEE_BLOCKED"),
        ("allowed_merchants", (), "VI_MERCHANT_BLOCKED"),
        ("allowed_skus", (), "VI_SKU_BLOCKED"),
        ("constraint_currency", "RLUSD", "VI_CURRENCY_BLOCKED"),
        ("recurrence", "DAILY", "VI_RECURRENCE_INVALID"),
        ("per_payment_max_usd_cents", 99, "VI_AMOUNT_BLOCKED"),
        ("per_payment_max_usd_cents", True, "VI_AMOUNT_BLOCKED"),
        ("expires_at", NOW, "VI_EXPIRED"),
        ("expires_at", True, "VI_EXPIRED"),
        ("checkout_hash", "wrong", "VI_CHECKOUT_MISMATCH"),
    ],
)
def test_vi_failure_matrix(field: str, value: object, code: str) -> None:
    current = request()
    harness = Harness(current)
    harness.vi = replace(harness.vi, **{field: value})
    outcome = run(current, harness.dependencies())
    assert outcome.validation_errors == (code,)
    assert harness.transport.calls == 0


def test_vi_payer_is_mandatory_and_directly_binds_decoded_payment() -> None:
    current = request()
    harness = Harness(current)
    harness.payment = replace(harness.payment, account="rOther")
    outcome = run(current, harness.dependencies())
    assert outcome.validation_errors == ("PAYMENT_PAYER_MISMATCH",)


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("accepted", False, "CREDENTIAL_NOT_ACCEPTED"),
        ("expiration_ripple", NOW - RIPPLE_EPOCH_UNIX_OFFSET, "CREDENTIAL_EXPIRED"),
        ("issuer", "wrong", "CREDENTIAL_ISSUER_MISMATCH"),
        ("credential_type", "00", "CREDENTIAL_TYPE_MISMATCH"),
        ("subject", "wrong", "CREDENTIAL_SUBJECT_MISMATCH"),
    ],
)
def test_credential_failure_matrix(field: str, value: object, code: str) -> None:
    current = request()
    harness = Harness(current)
    harness.ledger.record = replace(harness.ledger.record, **{field: value})
    outcome = run(current, harness.dependencies())
    assert outcome.validation_errors == (code,)


def test_ripple_epoch_conversion_is_explicit() -> None:
    assert ripple_epoch_to_unix(0) == RIPPLE_EPOCH_UNIX_OFFSET
    assert ripple_epoch_to_unix(NOW - RIPPLE_EPOCH_UNIX_OFFSET) == NOW


def test_credential_runtime_types_and_xrpl_limits_fail_closed() -> None:
    current = request()
    harness = Harness(current)
    harness.ledger.record = replace(harness.ledger.record, accepted=1)  # type: ignore[arg-type]
    assert run(current, harness.dependencies()).validation_errors == (
        "CREDENTIAL_NOT_ACCEPTED",
    )

    for blob in ("xyz", "123", "AA" * 8_193):
        malformed = request(
            payment_proof={
                "type": "xrpl_exact",
                "tx_blob": blob,
            }
        )
        assert run(malformed, Harness(malformed).dependencies()).validation_errors == (
            "PAYMENT_PROOF_MALFORMED",
        )

    too_many = request()
    too_many_harness = Harness(too_many)
    too_many_harness.payment = replace(
        too_many_harness.payment,
        credential_ids=tuple(f"{index:064X}" for index in range(9)),
    )
    assert run(too_many, too_many_harness.dependencies()).validation_errors == (
        "CREDENTIAL_IDS_INVALID",
    )

    attacker_ids = request(
        payment_proof={
            "type": "xrpl_exact",
            "tx_blob": "120000",
            "credential_ids": [CREDENTIAL_ID],
        }
    )
    assert run(
        attacker_ids, Harness(attacker_ids).dependencies()
    ).validation_errors == ("PAYMENT_PROOF_MALFORMED",)

    malformed_proof = request(payment_proof=[])  # type: ignore[arg-type]
    assert run(
        malformed_proof, Harness(malformed_proof).dependencies()
    ).validation_errors == ("PAYMENT_PROOF_MALFORMED",)


def test_named_check_payment_without_credential_is_rejected() -> None:
    current = request()
    harness = Harness(current)
    harness.payment = replace(harness.payment, credential_ids=())

    outcome = run(current, harness.dependencies())

    assert outcome.validation_errors == ("CREDENTIAL_IDS_INVALID",)
    assert harness.transport.calls == 0


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("transaction_type", "OfferCreate", "PAYMENT_TYPE_MISMATCH"),
        ("unknown_fields", ("SendMax",), "PAYMENT_FIELDS_INVALID"),
        ("unknown_fields", None, "PAYMENT_FIELDS_INVALID"),
        ("flags", 0x00020000, "PAYMENT_FLAGS_INVALID"),
        ("flags", 0x00010000, "PAYMENT_FLAGS_INVALID"),
        ("flags", True, "PAYMENT_FLAGS_INVALID"),
        ("network_id", 2, "PAYMENT_NETWORK_MISMATCH"),
        ("network_id", True, "PAYMENT_NETWORK_MISMATCH"),
        ("currency", "USD", "PAYMENT_CURRENCY_MISMATCH"),
        ("issuer", "wrong", "PAYMENT_ISSUER_MISMATCH"),
        ("value", "0.5", "PAYMENT_AMOUNT_MISMATCH"),
        ("source_tag", 1, "PAYMENT_SOURCE_TAG_MISMATCH"),
        ("source_tag", 2133.0, "PAYMENT_SOURCE_TAG_MISMATCH"),
        ("destination_tag", 1, "PAYMENT_DESTINATION_TAG_MISMATCH"),
        ("invoice_id", "wrong", "PAYMENT_INVOICE_MISMATCH"),
        ("memos", ("wrong",), "PAYMENT_MEMO_MISMATCH"),
        ("last_ledger_sequence", 10_000, "PAYMENT_LEDGER_WINDOW_INVALID"),
        ("last_ledger_sequence", 10_021, "PAYMENT_LEDGER_WINDOW_INVALID"),
        ("last_ledger_sequence", "10010", "PAYMENT_LEDGER_WINDOW_INVALID"),
        ("fee_drops", "01", "PAYMENT_FEE_INVALID"),
        ("fee_drops", "0", "PAYMENT_FEE_TOO_HIGH"),
        ("fee_drops", "101", "PAYMENT_FEE_TOO_HIGH"),
    ],
)
def test_decoded_payment_failure_matrix(field: str, value: object, code: str) -> None:
    current = request()
    harness = Harness(current)
    harness.payment = replace(harness.payment, **{field: value})
    outcome = run(current, harness.dependencies())
    assert outcome.validation_errors == (code,)


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("validated", False, "PAYMENT_NOT_VALIDATED"),
        ("validated", 1, "PAYMENT_NOT_VALIDATED"),
        ("engine_result", "tecNO_PERMISSION", "PAYMENT_NOT_VALIDATED"),
        ("tx_hash", "C" * 64, "PAYMENT_HASH_MISMATCH"),
        ("delivered_currency", "USD", "DELIVERED_CURRENCY_MISMATCH"),
        ("delivered_issuer", "wrong", "DELIVERED_ISSUER_MISMATCH"),
        ("delivered_value", "0.5", "DELIVERED_AMOUNT_MISMATCH"),
    ],
)
def test_settlement_failure_matrix(field: str, value: object, code: str) -> None:
    current = request()
    harness = Harness(current)
    harness.transport.result = replace(harness.transport.result, **{field: value})
    outcome = run(current, harness.dependencies())
    assert outcome.validation_errors == (code,)


def test_server_challenge_cannot_expand_payment_flag_policy() -> None:
    current = request(
        challenge=challenge(allowed_payment_flags=0xFFFFFFFF),
    )
    harness = Harness(current)
    harness.vi = replace(
        harness.vi,
        checkout_hash=checkout_digest(current),
    )
    outcome = run(current, harness.dependencies())
    assert outcome.validation_errors == ("CHALLENGE_STATE_INVALID",)

    float_mask = request(
        challenge=challenge(allowed_payment_flags=float(0x80000000)),
    )
    float_harness = Harness(float_mask)
    float_harness.vi = replace(
        float_harness.vi,
        checkout_hash=checkout_digest(float_mask),
    )
    float_outcome = run(float_mask, float_harness.dependencies())
    assert float_outcome.validation_errors == ("CHALLENGE_STATE_INVALID",)


def test_live_transport_is_fail_closed_until_explicit_gate() -> None:
    current = request()
    harness = Harness(current)
    blocked = run(current, harness.dependencies(payment_mode="live"))
    assert blocked.validation_errors == ("LIVE_GATE_CLOSED",)
    assert harness.transport.calls == 0
    allowed = run(
        current,
        harness.dependencies(payment_mode="live", allow_live=True),
    )
    assert allowed.validated


def test_payment_mode_and_live_boolean_are_closed() -> None:
    current = request()
    harness = Harness(current)
    unknown = run(current, harness.dependencies(payment_mode="stand-in"))
    assert unknown.validation_errors == ("PAYMENT_MODE_INVALID",)
    assert harness.transport.calls == 0

    harness = Harness(current)
    truthy_non_boolean = run(
        current,
        harness.dependencies(payment_mode="live", allow_live=1),  # type: ignore[arg-type]
    )
    assert truthy_non_boolean.validation_errors == ("LIVE_GATE_CLOSED",)
    assert harness.transport.calls == 0


def test_paychan_credential_passes_but_payment_waits_for_mm3() -> None:
    current = request(
        payment_proof={
            "type": "xrpl_paychan_claim",
            "channel_id": "D" * 64,
            "cumulative_drops": "50000",
            "signature": "public-signature",
            "public_key": "ED" + "11" * 32,
        }
    )
    harness = Harness(current)
    outcome = run(current, harness.dependencies())
    assert outcome.checks["credential"] == "pass"
    assert outcome.validation_errors == ("PAYCHAN_PENDING_MM3",)


def test_outcome_events_do_not_contain_untrusted_artifacts() -> None:
    current = request()
    outcome = run(current, Harness(current).dependencies())
    rendered = repr(outcome)
    for forbidden in (
        "public-l1.presentation",
        "public-l2.presentation",
        "public-l3b.presentation",
        "120000",
        CREDENTIAL_ID,
    ):
        assert forbidden not in rendered


def test_directory_fixture_is_bounded_json() -> None:
    encoded = json.dumps(directory_body(), separators=(",", ":")).encode()
    assert len(encoded) < DirectoryFetchPolicy().max_bytes
