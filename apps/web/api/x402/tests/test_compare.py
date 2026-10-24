from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import sqlite3
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping, Optional

import pytest
import httpx
from fastapi.testclient import TestClient

from apps.web.api.x402.compare import MERCHANT_BODY, RESOURCE_INFO, create_app
from apps.web.api.x402.config import (
    DEFAULT_PAY_TO,
    DEFAULT_SOURCE_TAG,
    ISOLATED_PRICE_DROPS,
    LOCAL_INVOICE_DB_PATH,
    MerchantConfig,
    RESOURCE_PATH,
    RESOURCE_URL,
    T54_TESTNET_FACILITATOR_URL,
    XRPL_TESTNET_JSON_RPC_URL,
)
from apps.web.api.x402.isolated_compare import create_isolated_app
from apps.web.api.x402.protocol import (
    MAX_JSON_DEPTH,
    MAX_JSON_KEY_BYTES,
    MAX_JSON_STRING_BYTES,
    MAX_PAYMENT_HEADER_BYTES,
    ProtocolError,
    assert_bounded_json,
    decode_payment_header,
    encode_header,
)
from apps.web.api.x402.profile_contract import (
    ISOLATED_HARBOR_ORIGIN,
    LEGACY_HARBOR_ORIGIN,
    main as profile_contract_main,
    validate_active_harbor_local_profile,
    validate_harbor_local_profile,
)
from apps.web.api.x402.store import (
    MAX_ACTIVE_INVOICES,
    InvoiceCapacityError,
    InvoiceStore,
    VERIFY_LEASE_SECONDS,
)
from apps.web.api.x402.verifier import (
    MAX_FACILITATOR_RESPONSE_BYTES,
    ReconciliationResult,
    T54Facilitator,
    VerificationError,
    VerificationRejected,
    VerificationReceipt,
)


PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn"
HASH = "A" * 64


class MutableClock:
    def __init__(self, value: float = 1_000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class FixtureReceiptVerifier:
    """Offline fixture verifier. It never performs network or ledger I/O."""

    fixture_only = True

    def __init__(
        self,
        *,
        receipt_override: Optional[Mapping[str, Any]] = None,
        settlement_override: Optional[Mapping[str, Any]] = None,
        verify_error_once: bool = False,
        settle_error: bool = False,
        reconcile_results: Optional[list[str]] = None,
        reconcile_error: bool = False,
    ) -> None:
        self.verify_calls = 0
        self.settle_calls = 0
        self.reconcile_calls = 0
        self.receipt_override = dict(receipt_override or {})
        self.settlement_override = dict(settlement_override or {})
        self.verify_error_once = verify_error_once
        self.settle_error = settle_error
        self.reconcile_results = list(reconcile_results or ["validated"])
        self.reconcile_error = reconcile_error

    async def current_validated_ledger(self) -> int:
        return 1_000

    @staticmethod
    def _receipt(
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
        override: Mapping[str, Any],
    ) -> VerificationReceipt:
        extra = payment_requirement["extra"]
        values = {
            "is_valid": True,
            "transaction": HASH,
            "network": "xrpl:1",
            "payer": PAYER,
            "pay_to": payment_requirement["payTo"],
            "amount_drops": payment_requirement["amount"],
            "fee_drops": "12",
            "invoice_id": extra["invoiceId"],
            "resource_url": resource["url"],
            "source_tag": extra["sourceTag"],
            "last_ledger_sequence": 1_050,
        }
        values.update(override)
        return VerificationReceipt(**values)

    async def verify(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        self.verify_calls += 1
        if self.verify_error_once and self.verify_calls == 1:
            raise VerificationError("offline_verify_failure")
        return self._receipt(payment_requirement, resource, self.receipt_override)

    async def settle(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        self.settle_calls += 1
        if self.settle_error:
            raise VerificationError("offline_settle_failure")
        return self._receipt(payment_requirement, resource, self.settlement_override)

    async def reconcile(
        self,
        receipt: VerificationReceipt,
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
        max_fee_drops: str,
        first_ledger_sequence: Optional[int],
    ) -> ReconciliationResult:
        self.reconcile_calls += 1
        if self.reconcile_error:
            raise VerificationError("offline_ledger_failure")
        status = (
            self.reconcile_results.pop(0)
            if len(self.reconcile_results) > 1
            else self.reconcile_results[0]
        )
        if status == "validated":
            return ReconciliationResult("validated", 1_040)
        if status == "not_included":
            return ReconciliationResult("not_included", 1_051)
        return ReconciliationResult("pending")


@pytest.fixture
def clock() -> MutableClock:
    return MutableClock()


@pytest.fixture
def config(tmp_path: Path) -> MerchantConfig:
    return MerchantConfig(
        pay_to=DEFAULT_PAY_TO,
        price_drops="5000",
        source_tag=DEFAULT_SOURCE_TAG,
        max_timeout_seconds=60,
        max_payer_fee_drops="100",
        invoice_db_path=tmp_path / "invoices.sqlite3",
    )


def challenge(client: TestClient) -> tuple[dict[str, Any], str]:
    response = client.get(RESOURCE_PATH)
    assert response.status_code == 402
    encoded = response.headers["payment-required"]
    decoded = decode_payment_header(encoded)
    assert decoded == response.json()
    return response.json(), encoded


def local_client(application: Any) -> TestClient:
    return TestClient(
        application,
        base_url="http://127.0.0.1:8000",
        client=("127.0.0.1", 50_000),
    )


def payment_for(challenge_body: Mapping[str, Any], blob: str = "ABCD") -> str:
    return encode_header(
        {
            "x402Version": 2,
            "resource": challenge_body["resource"],
            "accepted": challenge_body["accepts"][0],
            "payload": {"signedTxBlob": blob},
        }
    )


def test_402_fixture_verified_receipt_then_200(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "invoice-1")) as client:
        challenge_body, encoded = challenge(client)
        assert len(encoded) <= MAX_PAYMENT_HEADER_BYTES
        assert challenge_body == {
            "x402Version": 2,
            "error": "PAYMENT-SIGNATURE header is required",
            "resource": RESOURCE_INFO,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "xrpl:1",
                    "asset": "XRP",
                    "payTo": DEFAULT_PAY_TO,
                    "amount": "5000",
                    "maxTimeoutSeconds": 60,
                    "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
                }
            ],
            "extensions": {},
        }

        response = client.get(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": payment_for(challenge_body)},
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/json"
        assert response.json() == MERCHANT_BODY
        payment_response = decode_payment_header(response.headers["payment-response"])
        assert payment_response == {
            "success": True,
            "transaction": HASH,
            "network": "xrpl:1",
            "payer": PAYER,
        }
        assert verifier.verify_calls == 1
        assert verifier.settle_calls == 1
        assert verifier.reconcile_calls == 1


def test_challenge_persists_first_possible_validated_ledger(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    application = create_app(
        config,
        verifier,
        clock=clock,
        invoice_id_factory=lambda: "ledger-window",
    )
    with local_client(application) as client:
        body, _ = challenge(client)
        invoice = application.state.x402_service.store.get("ledger-window")
    assert body["accepts"][0]["extra"]["sourceTag"] == DEFAULT_SOURCE_TAG
    assert invoice is not None
    assert invoice.first_ledger_sequence == 1_001


def test_complete_resource_info_is_echoed_in_signature_fixture() -> None:
    fixture = json.loads(
        (
            Path(__file__).parent / "fixtures" / "harbor_x402_wire.json"
        ).read_text(encoding="utf-8")
    )
    signature = fixture["t54_payment_signature"]
    assert signature["resource"] == RESOURCE_INFO
    assert signature["accepted"]["payTo"] == DEFAULT_PAY_TO
    assert signature == {
        "x402Version": 2,
        "resource": RESOURCE_INFO,
        "accepted": {
            "scheme": "exact",
            "network": "xrpl:1",
            "asset": "XRP",
            "payTo": DEFAULT_PAY_TO,
            "amount": "5000",
            "maxTimeoutSeconds": 60,
            "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
        },
        "payload": {"signedTxBlob": "ABCD"},
    }
    assert signature["accepted"]["network"] == "xrpl:1"
    assert signature["accepted"]["asset"] == "XRP"
    assert fixture["verified_receipt"]["fixture"] is True
    assert signature["accepted"]["extra"]["sourceTag"] == DEFAULT_SOURCE_TAG


def test_harbor_local_profile_contract_uses_runtime_source_tag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile = tmp_path / "wrangler.local-x402.jsonc"
    profile.write_text(
        json.dumps(
            {
                "vars": {
                    "HARBOR_SOURCE_TAG": str(DEFAULT_SOURCE_TAG),
                    "EXEC_NETWORK": "testnet",
                    "MAINNET_EXECUTION": "false",
                    "HARBOR_LOCAL_X402": "true",
                }
            }
        ),
        encoding="utf-8",
    )
    validate_harbor_local_profile(
        profile,
        merchant_source_tag=DEFAULT_SOURCE_TAG,
        harbor_origin=LEGACY_HARBOR_ORIGIN,
    )
    monkeypatch.delenv("XRPL_X402_INVOICE_DB", raising=False)
    monkeypatch.delenv("XRPL_X402_FACILITATOR_URL", raising=False)
    monkeypatch.setenv("XRPL_X402_SOURCE_TAG", str(DEFAULT_SOURCE_TAG))
    assert validate_active_harbor_local_profile(
        profile, harbor_origin=LEGACY_HARBOR_ORIGIN
    ) == DEFAULT_SOURCE_TAG
    monkeypatch.setenv("XRPL_X402_SOURCE_TAG", str(DEFAULT_SOURCE_TAG + 1))
    with pytest.raises(ValueError, match="does not match"):
        validate_active_harbor_local_profile(
            profile, harbor_origin=LEGACY_HARBOR_ORIGIN
        )
    monkeypatch.setattr("sys.argv", [
        "profile_contract", str(profile),
        "--harbor-origin", LEGACY_HARBOR_ORIGIN,
    ])
    with pytest.raises(SystemExit) as cli_error:
        profile_contract_main()
    assert cli_error.value.code == 2

    mismatched = json.loads(profile.read_text(encoding="utf-8"))
    mismatched["vars"]["HARBOR_SOURCE_TAG"] = str(DEFAULT_SOURCE_TAG + 1)
    profile.write_text(json.dumps(mismatched), encoding="utf-8")
    validate_active_harbor_local_profile(
        profile, harbor_origin=LEGACY_HARBOR_ORIGIN
    )


def test_harbor_isolated_profile_contract_is_exact_and_rejects_trading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = tmp_path / "wrangler.local-x402-isolated-v1.jsonc"
    variables = {
        "HARBOR_SOURCE_TAG": str(DEFAULT_SOURCE_TAG),
        "EXEC_NETWORK": "testnet",
        "MAINNET_EXECUTION": "false",
        "EXECUTOR": "quickjs",
        "HARBOR_LOCAL_X402": "true",
        "HARBOR_LOCAL_READ_ONLY": "true",
        "HARBOR_LOCAL_AUTH_REQUIRED": "true",
        "HARBOR_LOCAL_CRON_DISABLED": "true",
        "HARBOR_LOCAL_X402_RUNTIME_ENABLED": "true",
        "HARBOR_LOCAL_X402_SIGNING_PROFILE": "reviewed-testnet-isolated-v1",
        "HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED": "true",
        "HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE":
            "reviewed-testnet-isolated-v1",
    }
    profile.write_text(json.dumps({"vars": variables}), encoding="utf-8")
    validate_harbor_local_profile(
        profile,
        merchant_source_tag=DEFAULT_SOURCE_TAG,
        harbor_origin=ISOLATED_HARBOR_ORIGIN,
    )
    monkeypatch.setenv("XRPL_X402_PRICE_DROPS", ISOLATED_PRICE_DROPS)
    monkeypatch.setenv("XRPL_X402_MAX_PAYER_FEE_DROPS", "100")
    monkeypatch.setenv("XRPL_X402_PAY_TO", DEFAULT_PAY_TO)
    validate_active_harbor_local_profile(
        profile,
        harbor_origin=ISOLATED_HARBOR_ORIGIN,
    )

    for changed_price in ("4999", "5001", "100000"):
        monkeypatch.setenv("XRPL_X402_PRICE_DROPS", changed_price)
        with pytest.raises(ValueError, match="exactly 5000"):
            validate_active_harbor_local_profile(
                profile,
                harbor_origin=ISOLATED_HARBOR_ORIGIN,
            )
    monkeypatch.setenv("XRPL_X402_PRICE_DROPS", ISOLATED_PRICE_DROPS)
    monkeypatch.setenv("XRPL_X402_PAY_TO", PAYER)
    with pytest.raises(ValueError, match="receiver must be the reviewed default"):
        validate_active_harbor_local_profile(
            profile,
            harbor_origin=ISOLATED_HARBOR_ORIGIN,
        )

    with pytest.raises(ValueError, match="origin is not exact"):
        validate_harbor_local_profile(
            profile,
            merchant_source_tag=DEFAULT_SOURCE_TAG,
            harbor_origin="http://127.0.0.3:8791",
        )

    for patch in (
        {"HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED": "false"},
        {"HARBOR_LOCAL_X402_SIGNING_PROFILE": "reviewed-testnet-local-v1"},
        {"HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED": "true"},
    ):
        profile.write_text(
            json.dumps({"vars": {**variables, **patch}}),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="isolated x402 profile"):
            validate_harbor_local_profile(
                profile,
                merchant_source_tag=DEFAULT_SOURCE_TAG,
                harbor_origin=ISOLATED_HARBOR_ORIGIN,
            )


def test_isolated_merchant_emits_only_exact_reviewed_price(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    isolated = replace(config, price_drops=ISOLATED_PRICE_DROPS)
    with local_client(
        create_isolated_app(
            isolated,
            verifier,
            clock=clock,
            invoice_id_factory=lambda: "isolated-price",
        )
    ) as client:
        body, _ = challenge(client)
    assert body["accepts"][0]["amount"] == ISOLATED_PRICE_DROPS
    assert body["accepts"][0]["payTo"] == DEFAULT_PAY_TO
    assert isolated.max_payer_fee_drops == "100"
    create_isolated_app(
        replace(isolated, max_payer_fee_drops="99"),
        verifier,
    )
    with pytest.raises(ValueError, match="at most 100"):
        replace(isolated, max_payer_fee_drops="101")

    for changed_price in ("4999", "5001", "100000"):
        with pytest.raises(ValueError, match="exactly 5000"):
            create_isolated_app(replace(config, price_drops=changed_price), verifier)
    with pytest.raises(ValueError, match="receiver must be the reviewed default"):
        create_isolated_app(replace(config, pay_to=PAYER), verifier)


def test_generic_merchant_retains_configurable_price_contract(
    config: MerchantConfig, clock: MutableClock
) -> None:
    generic = replace(config, pay_to=PAYER, price_drops="100000")
    with local_client(
        create_app(
            generic,
            FixtureReceiptVerifier(),
            clock=clock,
            invoice_id_factory=lambda: "generic-price",
        )
    ) as client:
        body, _ = challenge(client)
    assert body["accepts"][0]["amount"] == "100000"
    assert body["accepts"][0]["payTo"] == PAYER


def test_exact_replay_is_cached_without_duplicate_verification(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "durable")) as client:
        body, _ = challenge(client)
        signature = payment_for(body)
        first = client.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
        clock.value += 600
        replay = client.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
    assert first.status_code == replay.status_code == 200
    assert first.content == replay.content
    assert first.headers["payment-response"] == replay.headers["payment-response"]
    assert verifier.verify_calls == 1
    assert verifier.settle_calls == 1
    assert verifier.reconcile_calls == 1


def test_cached_delivery_survives_app_restart(
    config: MerchantConfig, clock: MutableClock
) -> None:
    first_verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, first_verifier, clock=clock, invoice_id_factory=lambda: "restart")) as first:
        body, _ = challenge(first)
        signature = payment_for(body)
        assert first.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}).status_code == 200
    second_verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, second_verifier, clock=clock)) as second:
        replay = second.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
    assert replay.status_code == 200
    assert second_verifier.verify_calls == 0
    assert second_verifier.settle_calls == 0
    assert second_verifier.reconcile_calls == 0


def test_conflicting_replay_is_rejected(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "replay")) as client:
        body, _ = challenge(client)
        assert client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": payment_for(body, "ABCD")}
        ).status_code == 200
        conflict = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": payment_for(body, "ABCE")}
        )
    assert conflict.status_code == 409
    assert conflict.json() == {"error": "invoice_replay_conflict"}
    assert verifier.verify_calls == 1
    assert verifier.settle_calls == 1


def test_expired_unpaid_invoice_is_rejected(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "expired")) as client:
        body, _ = challenge(client)
        clock.value += 61
        response = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": payment_for(body)}
        )
    assert response.status_code == 402
    assert response.json() == {"error": "expired_invoice"}
    assert verifier.verify_calls == 0


@pytest.mark.parametrize(
    ("field", "value"),
    (("network", "xrpl:0"), ("asset", "USD"), ("amount", "100001")),
)
def test_tampered_or_unsupported_requirement_is_rejected(
    config: MerchantConfig,
    clock: MutableClock,
    field: str,
    value: str,
) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: field)) as client:
        body, _ = challenge(client)
        payload = {
            "x402Version": 2,
            "resource": body["resource"],
            "accepted": copy.deepcopy(body["accepts"][0]),
            "payload": {"signedTxBlob": "ABCD"},
        }
        payload["accepted"][field] = value
        response = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": encode_header(payload)}
        )
    assert response.status_code == 402
    assert response.json() == {"error": "payment_requirements_mismatch"}
    assert verifier.verify_calls == 0


def test_resource_url_binding_is_exact(config: MerchantConfig, clock: MutableClock) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "url")) as client:
        body, _ = challenge(client)
        payload = {
            "x402Version": 2,
            "resource": {**body["resource"], "url": "http://127.0.0.1:8000/other"},
            "accepted": body["accepts"][0],
            "payload": {"signedTxBlob": "ABCD"},
        }
        response = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": encode_header(payload)}
        )
    assert response.status_code == 402
    assert response.json() == {"error": "resource_url_mismatch"}
    assert verifier.verify_calls == 0


def test_wrong_method_never_verifies(config: MerchantConfig, clock: MutableClock) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "method")) as client:
        body, _ = challenge(client)
        response = client.post(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": payment_for(body)}
        )
    assert response.status_code == 405
    assert verifier.verify_calls == 0


def test_invalid_and_oversized_payment_headers_fail_closed(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    with local_client(create_app(config, verifier, clock=clock)) as client:
        invalid = client.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": "not-base64"})
        oversized = client.get(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": "A" * (MAX_PAYMENT_HEADER_BYTES + 4)},
        )
    assert invalid.status_code == 400
    assert oversized.status_code == 413
    assert verifier.verify_calls == 0


@pytest.mark.parametrize(
    "override",
    (
        {"network": "xrpl:0"},
        {"resource_url": "http://127.0.0.1:8000/other"},
        {"fee_drops": "101"},
        {"transaction": "not-a-hash"},
    ),
)
def test_invalid_fixture_receipt_never_releases_resource(
    config: MerchantConfig,
    clock: MutableClock,
    override: Mapping[str, Any],
) -> None:
    verifier = FixtureReceiptVerifier(receipt_override=override)
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "bad-receipt")) as client:
        body, _ = challenge(client)
        response = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": payment_for(body)}
        )
    assert response.status_code == 402
    assert response.json() == {"error": "receipt_binding_mismatch"}
    assert verifier.settle_calls == 0


def test_verification_transport_failure_is_retryable_before_settlement(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier(verify_error_once=True)
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "retry")) as client:
        body, _ = challenge(client)
        signature = payment_for(body)
        first = client.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
        second = client.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
    assert first.status_code == 503
    assert first.json()["settlementAttempted"] is False
    assert second.status_code == 200
    assert verifier.verify_calls == 2
    assert verifier.settle_calls == 1


def test_uncertain_settlement_is_never_attempted_twice(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier(settle_error=True, reconcile_results=["pending"])
    with local_client(create_app(config, verifier, clock=clock, invoice_id_factory=lambda: "unknown")) as client:
        body, _ = challenge(client)
        signature = payment_for(body)
        first = client.get(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
    assert first.status_code == 503
    assert first.json() == {
        "error": "settlement_pending_validation",
        "retryable": True,
        "phase": "reconcile",
        "settlementAttempted": True,
    }
    recovery = FixtureReceiptVerifier(reconcile_results=["validated"])
    with local_client(create_app(config, recovery, clock=clock)) as restarted:
        replay = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert replay.status_code == 200
    assert verifier.verify_calls == 1
    assert verifier.settle_calls == 1
    assert verifier.reconcile_calls == 1
    assert recovery.verify_calls == 0
    assert recovery.settle_calls == 0
    assert recovery.reconcile_calls == 1


def test_abandoned_read_only_verification_claim_can_be_recovered(
    tmp_path: Path, clock: MutableClock
) -> None:
    store = InvoiceStore(tmp_path / "lease.sqlite3", clock)
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "lease"},
    }
    store.put("lease", RESOURCE_INFO, requirement, 60)
    assert store.claim("lease", "signature-a").outcome == "claimed"
    assert store.claim("lease", "signature-a").outcome == "in_progress"
    assert store.claim("lease", "signature-b").outcome == "conflict"
    clock.value += VERIFY_LEASE_SECONDS
    assert store.claim("lease", "signature-a").outcome == "claimed"


def test_abandoned_verification_cannot_revive_expired_invoice(
    tmp_path: Path, clock: MutableClock
) -> None:
    store = InvoiceStore(tmp_path / "expired-lease.sqlite3", clock)
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 10,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "expired-lease"},
    }
    store.put("expired-lease", RESOURCE_INFO, requirement, 10)
    assert store.claim("expired-lease", "signature-a").outcome == "claimed"
    clock.value += VERIFY_LEASE_SECONDS
    assert store.claim("expired-lease", "signature-a").outcome == "expired"


def test_legacy_invoice_database_is_migrated_for_settlement(
    tmp_path: Path, clock: MutableClock
) -> None:
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE x402_invoices (
                invoice_id TEXT PRIMARY KEY,
                resource_json TEXT NOT NULL,
                requirement_json TEXT NOT NULL,
                issued_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending', 'verifying', 'delivered')),
                signature_hash TEXT,
                response_json TEXT,
                payment_response TEXT
            )
            """
        )
    store = InvoiceStore(path, clock)
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "migrated"},
    }
    store.put("migrated", RESOURCE_INFO, requirement, 60)
    claim = store.claim("migrated", "signature-a")
    assert claim.outcome == "claimed"
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    transition = store.mark_settling(
        "migrated", "signature-a", claim.invoice.claim_generation, receipt
    )
    assert transition.outcome == "settling"
    assert transition.invoice.first_ledger_sequence is None


def _seed_legacy_settling_invoice(
    config: MerchantConfig,
    clock: MutableClock,
) -> tuple[str, Mapping[str, Any]]:
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {
            "sourceTag": DEFAULT_SOURCE_TAG,
            "invoiceId": "legacy-settling",
        },
    }
    signature = encode_header(
        {
            "x402Version": 2,
            "resource": RESOURCE_INFO,
            "accepted": requirement,
            "payload": {"signedTxBlob": "ABCD"},
        }
    )
    fingerprint = hashlib.sha256(signature.encode("ascii")).hexdigest()
    store = InvoiceStore(config.invoice_db_path, clock)
    store.put("legacy-settling", RESOURCE_INFO, requirement, 60)
    claim = store.claim("legacy-settling", fingerprint)
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    assert store.mark_settling(
        "legacy-settling",
        fingerprint,
        claim.invoice.claim_generation,
        receipt,
    ).outcome == "settling"
    legacy_receipt = dict(receipt.__dict__)
    legacy_receipt.pop("last_ledger_sequence")
    with sqlite3.connect(config.invoice_db_path) as connection:
        connection.execute(
            "UPDATE x402_invoices SET verified_receipt_json = ? WHERE invoice_id = ?",
            (
                json.dumps(legacy_receipt, separators=(",", ":"), sort_keys=True),
                "legacy-settling",
            ),
        )
    return signature, requirement


def test_preexisting_settling_receipt_without_lls_recovers_by_presence_only(
    config: MerchantConfig, clock: MutableClock
) -> None:
    signature, requirement = _seed_legacy_settling_invoice(config, clock)
    requests: list[Mapping[str, Any]] = []

    def ledger(request: Any) -> Any:
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(
            200,
            json={
                "result": {
                    "validated": True,
                    "hash": HASH,
                    "ledger_index": 1_040,
                    "meta": {
                        "TransactionResult": "tesSUCCESS",
                        "delivered_amount": "5000",
                    },
                    "tx_json": {
                        "TransactionType": "Payment",
                        "Account": PAYER,
                        "Destination": DEFAULT_PAY_TO,
                        "DeliverMax": "5000",
                        "Fee": "12",
                        "SourceTag": DEFAULT_SOURCE_TAG,
                        "LastLedgerSequence": 1_050,
                        "InvoiceID": hashlib.sha256(
                            b"legacy-settling"
                        ).hexdigest().upper(),
                        "Flags": 0,
                    },
                }
            },
        )

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    with local_client(create_app(config, verifier, clock=clock)) as restarted:
        response = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
        recovered = restarted.app.state.x402_service.store.get("legacy-settling")
    assert response.status_code == 200
    assert recovered is not None and recovered.state == "delivered"
    assert requests == [
        {
            "method": "tx",
            "params": [
                {"transaction": HASH, "binary": False, "api_version": 2}
            ],
        }
    ]
    assert requirement["extra"]["sourceTag"] == DEFAULT_SOURCE_TAG


def test_preexisting_settling_receipt_without_lls_never_terminalizes_absence(
    config: MerchantConfig, clock: MutableClock
) -> None:
    signature, _ = _seed_legacy_settling_invoice(config, clock)
    requests = 0

    def ledger(_: Any) -> Any:
        nonlocal requests
        requests += 1
        return httpx.Response(
            200,
            json={"result": {"error": "txnNotFound", "searched_all": True}},
        )

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    with local_client(create_app(config, verifier, clock=clock)) as restarted:
        first = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
        second = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
        retained = restarted.app.state.x402_service.store.get("legacy-settling")
    assert first.status_code == second.status_code == 503
    assert retained is not None and retained.state == "settling"
    assert retained.terminal_ledger_index is None
    assert requests == 2


def test_config_rejects_excessive_caps_invalid_address_and_arbitrary_facilitator(
    config: MerchantConfig,
) -> None:
    with pytest.raises(ValueError, match="at most 100000"):
        replace(config, price_drops="100001")
    with pytest.raises(ValueError, match="at most 100"):
        replace(config, max_payer_fee_drops="101")
    with pytest.raises(ValueError, match="classic address"):
        replace(config, pay_to="not-an-address")
    with pytest.raises(ValueError, match="fixed T54"):
        replace(config, facilitator_url="http://127.0.0.1:9999")
    with pytest.raises(ValueError, match="official XRPL Testnet"):
        replace(config, xrpl_json_rpc_url="https://mainnet.example")
    assert config.facilitator_url == T54_TESTNET_FACILITATOR_URL
    assert config.xrpl_json_rpc_url == XRPL_TESTNET_JSON_RPC_URL
    assert RESOURCE_URL == "http://127.0.0.1:8000/api/x402/compare"


def test_environment_default_source_tag_matches_local_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "XRPL_X402_PAY_TO",
        "XRPL_X402_PRICE_DROPS",
        "XRPL_X402_SOURCE_TAG",
        "XRPL_X402_TIMEOUT_SECONDS",
        "XRPL_X402_MAX_PAYER_FEE_DROPS",
        "XRPL_X402_INVOICE_DB",
        "XRPL_X402_FACILITATOR_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    assert MerchantConfig.from_env().source_tag == DEFAULT_SOURCE_TAG == 2_610_240


def test_real_facilitator_targets_are_fixed_and_redirects_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inspected = VerificationReceipt(
        is_valid=True,
        transaction=HASH,
        network="xrpl:1",
        payer=PAYER,
        pay_to=DEFAULT_PAY_TO,
        amount_drops="5000",
        fee_drops="12",
        invoice_id="invoice-1",
        resource_url="",
        source_tag=DEFAULT_SOURCE_TAG,
    )
    monkeypatch.setattr(
        "apps.web.api.x402.verifier._inspect_transaction",
        lambda signed_blob, requirement: inspected,
    )
    seen: list[tuple[str, Mapping[str, Any]]] = []

    def redirect(request: Any) -> Any:
        seen.append((str(request.url), json.loads(request.content)))
        return httpx.Response(302, headers={"location": "https://evil.test"})

    verifier = T54Facilitator(transport=httpx.MockTransport(redirect))
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
    }
    payload = {
        "x402Version": 2,
        "resource": RESOURCE_INFO,
        "accepted": requirement,
        "payload": {"signedTxBlob": "ABCD"},
    }
    with pytest.raises(VerificationError, match="redirect_rejected"):
        asyncio.run(verifier.verify(payload, requirement, RESOURCE_INFO))
    assert seen == [
        (
            "https://xrpl-facilitator-testnet.t54.ai/verify",
            {"paymentPayload": payload, "paymentRequirements": requirement},
        )
    ]


def test_real_facilitator_response_is_bounded() -> None:
    def oversized(request: Any) -> Any:
        return httpx.Response(
            200,
            headers={"content-length": str(MAX_FACILITATOR_RESPONSE_BYTES + 1)},
            content=b"{}",
        )

    verifier = T54Facilitator(transport=httpx.MockTransport(oversized))
    with pytest.raises(VerificationError, match="response_too_large"):
        asyncio.run(verifier._post_bounded("/verify", {}))


def test_settlement_fence_recovers_validated_payment_after_restart(
    config: MerchantConfig, clock: MutableClock
) -> None:
    first_verifier = FixtureReceiptVerifier(reconcile_results=["pending"])
    application = create_app(
        config,
        first_verifier,
        clock=clock,
        invoice_id_factory=lambda: "crash-recovery",
    )
    with local_client(application) as first:
        body, _ = challenge(first)
        signature = payment_for(body)
        fingerprint = hashlib.sha256(signature.encode("ascii")).hexdigest()
        service = application.state.x402_service
        claim = service.store.claim("crash-recovery", fingerprint)
        receipt = FixtureReceiptVerifier._receipt(
            body["accepts"][0], body["resource"], {}
        )
        transition = service.store.mark_settling(
            "crash-recovery",
            fingerprint,
            claim.invoice.claim_generation,
            receipt,
        )
        assert transition.outcome == "settling"

    recovery_verifier = FixtureReceiptVerifier(reconcile_results=["validated"])
    with local_client(create_app(config, recovery_verifier, clock=clock)) as restarted:
        recovered = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert recovered.status_code == 200
    assert recovery_verifier.verify_calls == 0
    assert recovery_verifier.settle_calls == 0
    assert recovery_verifier.reconcile_calls == 1


def test_verification_claim_generation_blocks_stale_worker_mutation(
    tmp_path: Path, clock: MutableClock
) -> None:
    store = InvoiceStore(tmp_path / "generation.sqlite3", clock)
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "generation"},
    }
    store.put("generation", RESOURCE_INFO, requirement, 60)
    first = store.claim("generation", "signature-a")
    clock.value += VERIFY_LEASE_SECONDS
    second = store.claim("generation", "signature-a")
    assert second.invoice.claim_generation == first.invoice.claim_generation + 1
    assert not store.release(
        "generation", "signature-a", first.invoice.claim_generation
    )
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    stale = store.mark_settling(
        "generation", "signature-a", first.invoice.claim_generation, receipt
    )
    assert stale.outcome == "claim_lost"
    current = store.mark_settling(
        "generation", "signature-a", second.invoice.claim_generation, receipt
    )
    assert current.outcome == "settling"


def test_mark_settling_checks_expiry_inside_write_transaction(
    tmp_path: Path, clock: MutableClock
) -> None:
    store = InvoiceStore(tmp_path / "atomic-expiry.sqlite3", clock)
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 1,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "atomic-expiry"},
    }
    store.put("atomic-expiry", RESOURCE_INFO, requirement, 1)
    claim = store.claim("atomic-expiry", "signature-a")
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    results: list[Any] = []
    started = threading.Event()
    with sqlite3.connect(tmp_path / "atomic-expiry.sqlite3", isolation_level=None) as lock:
        lock.execute("BEGIN IMMEDIATE")

        def transition_after_lock() -> None:
            started.set()
            results.append(
                store.mark_settling(
                    "atomic-expiry",
                    "signature-a",
                    claim.invoice.claim_generation,
                    receipt,
                )
            )

        worker = threading.Thread(target=transition_after_lock)
        worker.start()
        assert started.wait(timeout=1)
        time.sleep(0.05)
        clock.value += 1
        lock.execute("COMMIT")
        worker.join(timeout=1)
    assert not worker.is_alive()
    transition = results[0]
    assert transition.outcome == "expired"
    assert store.get("atomic-expiry").state == "verifying"


def test_untrusted_json_depth_and_encoding_fail_without_recursion(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier()
    deeply_nested = ("[" * 1000 + "0" + "]" * 1000).encode("ascii")
    encoded = base64.b64encode(deeply_nested).decode("ascii")
    with local_client(create_app(config, verifier, clock=clock)) as client:
        response = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": encoded}
        )
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_payment_signature_json"}

    def malformed(_: Any) -> Any:
        return httpx.Response(200, content=b'\xff')

    real = T54Facilitator(transport=httpx.MockTransport(malformed))
    with pytest.raises(VerificationError, match="invalid_facilitator_response"):
        asyncio.run(real._post_bounded("/verify", {}))

    nested_response = b'{"a":' * 100 + b"0" + b"}" * 100

    def deeply_nested_facilitator(_: Any) -> Any:
        return httpx.Response(200, content=nested_response)

    nested_real = T54Facilitator(
        transport=httpx.MockTransport(deeply_nested_facilitator)
    )
    with pytest.raises(VerificationError, match="invalid_facilitator_response"):
        asyncio.run(nested_real._post_bounded("/verify", {}))


def test_create_app_is_filesystem_lazy_and_rejects_symlink_database(
    config: MerchantConfig, tmp_path: Path
) -> None:
    lazy_path = tmp_path / "lazy" / "invoices.sqlite3"
    application = create_app(replace(config, invoice_db_path=lazy_path))
    assert not lazy_path.exists()
    with local_client(application):
        assert lazy_path.exists()

    target = tmp_path / "target.sqlite3"
    target.touch()
    link = tmp_path / "linked.sqlite3"
    link.symlink_to(target)
    linked_app = create_app(replace(config, invoice_db_path=link))
    with pytest.raises(ValueError, match="symlink"):
        with local_client(linked_app):
            pass


def test_environment_cannot_select_database_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("XRPL_X402_INVOICE_DB", "/tmp/hostile.sqlite3")
    with pytest.raises(ValueError, match="not configurable"):
        MerchantConfig.from_env()
    monkeypatch.delenv("XRPL_X402_INVOICE_DB")
    assert MerchantConfig.from_env().invoice_db_path == LOCAL_INVOICE_DB_PATH


def test_loopback_host_origin_and_client_are_enforced(
    config: MerchantConfig, clock: MutableClock
) -> None:
    application = create_app(config, FixtureReceiptVerifier(), clock=clock)
    with local_client(application) as client:
        assert client.get(RESOURCE_PATH).status_code == 402
        assert client.get(RESOURCE_PATH, headers={"host": "localhost:8000"}).status_code == 403
        assert client.get(
            RESOURCE_PATH, headers={"origin": "https://evil.example"}
        ).status_code == 403
        assert client.get(
            RESOURCE_PATH, headers={"x-forwarded-for": "127.0.0.1"}
        ).status_code == 403
    with TestClient(
        application,
        base_url="http://127.0.0.1:8000",
        client=("10.0.0.2", 50_000),
    ) as remote:
        assert remote.get(RESOURCE_PATH).status_code == 403


def test_unpaid_challenge_is_reused_and_expired_pending_rows_are_pruned(
    config: MerchantConfig, clock: MutableClock
) -> None:
    counter = iter(("reuse-1", "reuse-2", "reuse-3"))
    application = create_app(
        config,
        FixtureReceiptVerifier(),
        clock=clock,
        invoice_id_factory=lambda: next(counter),
    )
    with local_client(application) as client:
        first, _ = challenge(client)
        second, _ = challenge(client)
        assert second == first
        clock.value += config.max_timeout_seconds
        third, _ = challenge(client)
    assert third["accepts"][0]["extra"]["invoiceId"] == "reuse-3"
    with sqlite3.connect(config.invoice_db_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM x402_invoices WHERE state = 'pending'"
        ).fetchone()[0] == 1


def test_active_invoice_quota_is_bounded(tmp_path: Path, clock: MutableClock) -> None:
    store = InvoiceStore(tmp_path / "quota.sqlite3", clock)
    for index in range(MAX_ACTIVE_INVOICES):
        invoice_id = f"quota-{index}"
        requirement = {
            "scheme": "exact",
            "network": "xrpl:1",
            "asset": "XRP",
            "payTo": DEFAULT_PAY_TO,
            "amount": "5000",
            "maxTimeoutSeconds": 60,
            "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": invoice_id},
        }
        invoice = store.put_or_reuse(invoice_id, RESOURCE_INFO, requirement, 60)
        assert invoice is not None and invoice.invoice_id == invoice_id
        assert store.claim(invoice_id, f"signature-{index}").outcome == "claimed"
    final_requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "over-quota"},
    }
    with pytest.raises(InvoiceCapacityError, match="active_capacity_reached"):
        store.put_or_reuse("over-quota", RESOURCE_INFO, final_requirement, 60)


def test_total_history_quota_preserves_terminal_and_unknown_recovery(
    tmp_path: Path, clock: MutableClock
) -> None:
    store = InvoiceStore(
        tmp_path / "history-quota.sqlite3",
        clock,
        max_active_invoices=4,
        max_total_invoices=4,
    )
    signatures: dict[str, str] = {}
    for index in range(4):
        invoice_id = f"history-{index}"
        requirement = {
            "scheme": "exact",
            "network": "xrpl:1",
            "asset": "XRP",
            "payTo": DEFAULT_PAY_TO,
            "amount": "5000",
            "maxTimeoutSeconds": 60,
            "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": invoice_id},
        }
        invoice = store.put_or_reuse(invoice_id, RESOURCE_INFO, requirement, 60)
        assert invoice is not None and invoice.invoice_id == invoice_id
        signature = f"signature-{index}"
        signatures[invoice_id] = signature
        claim = store.claim(invoice_id, signature)
        receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
        assert store.mark_settling(
            invoice_id,
            signature,
            claim.invoice.claim_generation,
            receipt,
        ).outcome == "settling"
        if index % 2 == 0:
            store.complete(
                invoice_id,
                signature,
                receipt.transaction,
                MERCHANT_BODY,
                "fixture-payment-response",
            )

    over_quota_requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "history-over-quota"},
    }
    with pytest.raises(InvoiceCapacityError, match="history_capacity_reached"):
        store.put_or_reuse(
            "history-over-quota", RESOURCE_INFO, over_quota_requirement, 60
        )
    assert store.claim("history-0", signatures["history-0"]).outcome == "cached"
    assert store.claim("history-1", signatures["history-1"]).outcome == "reconcile"
    with sqlite3.connect(tmp_path / "history-quota.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM x402_invoices").fetchone()[0] == 4


def test_history_capacity_response_preserves_unknown_payment_recovery(
    config: MerchantConfig, clock: MutableClock
) -> None:
    verifier = FixtureReceiptVerifier(reconcile_results=["validated"])
    application = create_app(
        config,
        verifier,
        clock=clock,
        invoice_id_factory=lambda: "capacity-existing",
    )
    with local_client(application) as client:
        body, _ = challenge(client)
        signature = payment_for(body)
        fingerprint = hashlib.sha256(signature.encode("ascii")).hexdigest()
        service = application.state.x402_service
        claim = service.store.claim("capacity-existing", fingerprint)
        receipt = FixtureReceiptVerifier._receipt(
            body["accepts"][0], body["resource"], {}
        )
        service.store.mark_settling(
            "capacity-existing",
            fingerprint,
            claim.invoice.claim_generation,
            receipt,
        )
        service.store._max_total_invoices = 1
        exhausted = client.get(RESOURCE_PATH)
        recovered = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert exhausted.status_code == 429
    assert exhausted.json() == {
        "error": "history_capacity_reached",
        "retryable": False,
        "operatorAction": (
            "Preserve the invoice database and review retained audit records "
            "before increasing the explicit local quota."
        ),
    }
    assert recovered.status_code == 200
    assert verifier.settle_calls == 0
    assert verifier.reconcile_calls == 1


def test_concurrent_same_signature_absence_terminalization_is_idempotent(
    tmp_path: Path, clock: MutableClock
) -> None:
    store = InvoiceStore(tmp_path / "terminal-race.sqlite3", clock)
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "race"},
    }
    store.put("race", RESOURCE_INFO, requirement, 60, 1_001)
    claim = store.claim("race", "same-signature")
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    assert store.mark_settling(
        "race",
        "same-signature",
        claim.invoice.claim_generation,
        receipt,
    ).outcome == "settling"

    barrier = threading.Barrier(3)
    results: list[Any] = []
    errors: list[BaseException] = []

    def terminalize(validated_ledger_index: int) -> None:
        barrier.wait()
        try:
            results.append(
                store.mark_not_included(
                    "race",
                    "same-signature",
                    HASH,
                    validated_ledger_index,
                )
            )
        except BaseException as exc:  # captured for an assertion in the main thread
            errors.append(exc)

    workers = [
        threading.Thread(target=terminalize, args=(1_051,)),
        threading.Thread(target=terminalize, args=(1_052,)),
    ]
    for worker in workers:
        worker.start()
    barrier.wait()
    for worker in workers:
        worker.join()

    assert errors == []
    assert len(results) == 2
    assert {result.state for result in results} == {"not_included"}
    assert len({result.terminal_ledger_index for result in results}) == 1
    stored = store.get("race")
    assert stored is not None
    assert stored.terminal_ledger_index == results[0].terminal_ledger_index


@pytest.mark.parametrize(
    "change",
    ("pay_to", "price", "source_tag", "timeout", "resource"),
)
def test_pending_invoice_reuse_requires_exact_current_offer(
    tmp_path: Path, clock: MutableClock, change: str
) -> None:
    path = tmp_path / f"offer-{change}.sqlite3"
    old_requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "old-invoice"},
    }
    first = InvoiceStore(path, clock)
    first.put("old-invoice", RESOURCE_INFO, old_requirement, 60)

    new_resource = copy.deepcopy(RESOURCE_INFO)
    new_requirement = copy.deepcopy(old_requirement)
    new_requirement["extra"]["invoiceId"] = "new-invoice"
    if change == "pay_to":
        new_requirement["payTo"] = PAYER
    elif change == "price":
        new_requirement["amount"] = "6000"
    elif change == "source_tag":
        new_requirement["extra"]["sourceTag"] = DEFAULT_SOURCE_TAG + 1
    elif change == "timeout":
        new_requirement["maxTimeoutSeconds"] = 30
    else:
        new_resource["description"] = "Changed fixed resource"

    restarted = InvoiceStore(path, clock)
    issued = restarted.put_or_reuse(
        "new-invoice", new_resource, new_requirement, 60
    )
    assert issued is not None
    assert issued.invoice_id == "new-invoice"
    assert restarted.get("old-invoice") is not None


def test_invoice_ttl_never_implies_unincluded_transaction(
    config: MerchantConfig, clock: MutableClock
) -> None:
    first_verifier = FixtureReceiptVerifier(
        settle_error=True, reconcile_results=["pending"]
    )
    with local_client(
        create_app(
            config,
            first_verifier,
            clock=clock,
            invoice_id_factory=lambda: "expired-unincluded",
        )
    ) as first:
        body, _ = challenge(first)
        signature = payment_for(body)
        assert first.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        ).status_code == 503

    clock.value += config.max_timeout_seconds + 1
    still_unknown = FixtureReceiptVerifier(reconcile_results=["pending"])
    with local_client(create_app(config, still_unknown, clock=clock)) as restarted:
        pending = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert pending.status_code == 503
    assert pending.json()["error"] == "settlement_pending_validation"

    confirmed_absent = FixtureReceiptVerifier(reconcile_results=["not_included"])
    with local_client(create_app(config, confirmed_absent, clock=clock)) as restarted:
        terminal = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert terminal.status_code == 410
    assert terminal.json()["validatedLedgerIndex"] == 1_051
    assert confirmed_absent.settle_calls == 0

    no_lookup = FixtureReceiptVerifier(reconcile_results=["validated"])
    with local_client(create_app(config, no_lookup, clock=clock)) as restarted:
        replay = restarted.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert replay.status_code == 410
    assert no_lookup.reconcile_calls == 0


def test_confirmed_absence_requires_validated_ledger_past_lls() -> None:
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
    }
    receipt = FixtureReceiptVerifier._receipt(
        requirement,
        RESOURCE_INFO,
        {"last_ledger_sequence": 90_000_999},
    )
    requests: list[str] = []
    tx_requests = 0

    def ledger(request: Any) -> Any:
        nonlocal tx_requests
        body = json.loads(request.content)
        requests.append(body["method"])
        if body["method"] == "tx":
            tx_requests += 1
            expected = {
                "transaction": HASH,
                "binary": False,
                "api_version": 2,
            }
            if tx_requests == 2:
                expected.update(
                    {"min_ledger": 90_000_000, "max_ledger": 90_000_999}
                )
            assert body["params"] == [expected]
            return httpx.Response(
                200,
                json={
                    "result": {
                        "error": "txnNotFound",
                        "searched_all": True,
                    }
                },
            )
        return httpx.Response(
            200,
            json={"result": {"validated": True, "ledger_index": 90_001_000}},
        )

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    result = asyncio.run(
        verifier.reconcile(
            receipt, requirement, RESOURCE_INFO, "100", 90_000_000
        )
    )
    assert result == ReconciliationResult("not_included", 90_001_000)
    assert requests == ["tx", "ledger", "tx"]


def test_reconciliation_rejects_more_than_1000_ledger_search_window() -> None:
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
    }
    receipt = FixtureReceiptVerifier._receipt(
        requirement,
        RESOURCE_INFO,
        {"last_ledger_sequence": 90_001_000},
    )
    calls = 0

    def ledger(_: Any) -> Any:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    with pytest.raises(VerificationRejected, match="receipt_binding_mismatch"):
        asyncio.run(
            verifier.reconcile(
                receipt,
                requirement,
                RESOURCE_INFO,
                "100",
                90_000_000,
            )
        )
    assert calls == 0

    with pytest.raises(VerificationError, match="invalid_ledger_search_range"):
        asyncio.run(
            verifier._ledger_tx(
                HASH,
                min_ledger=90_000_000,
                max_ledger=90_001_000,
            )
        )
    assert calls == 0


def test_reconciliation_waits_for_closed_last_ledger_sequence_window() -> None:
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
    }
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    requests: list[str] = []

    def ledger(request: Any) -> Any:
        body = json.loads(request.content)
        requests.append(body["method"])
        if body["method"] == "tx":
            return httpx.Response(
                200, json={"result": {"error": "txnNotFound"}}
            )
        return httpx.Response(
            200,
            json={"result": {"validated": True, "ledger_index": 1_050}},
        )

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    result = asyncio.run(
        verifier.reconcile(receipt, requirement, RESOURCE_INFO, "100", 1_001)
    )
    assert result == ReconciliationResult("pending")
    assert requests == ["tx", "ledger"]


def test_reconciliation_requires_searched_all_for_bounded_absence() -> None:
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
    }
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})

    tx_requests = 0

    def ledger(request: Any) -> Any:
        nonlocal tx_requests
        body = json.loads(request.content)
        if body["method"] == "ledger":
            return httpx.Response(
                200,
                json={"result": {"validated": True, "ledger_index": 1_051}},
            )
        tx_requests += 1
        if tx_requests == 1:
            assert "min_ledger" not in body["params"][0]
            return httpx.Response(
                200, json={"result": {"error": "txnNotFound"}}
            )
        assert body["params"][0]["min_ledger"] == 1_001
        assert body["params"][0]["max_ledger"] == 1_050
        return httpx.Response(
            200,
            json={"result": {"error": "txnNotFound", "searched_all": False}},
        )

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    result = asyncio.run(
        verifier.reconcile(receipt, requirement, RESOURCE_INFO, "100", 1_001)
    )
    assert result == ReconciliationResult("pending")


def test_ledger_reconciliation_binds_validated_exact_payment() -> None:
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
    }
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    seen: list[Mapping[str, Any]] = []

    def ledger(request: Any) -> Any:
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(
            200,
            json={
                "result": {
                    "validated": True,
                    "hash": HASH,
                    "ledger_index": 1_040,
                    "meta": {
                        "TransactionResult": "tesSUCCESS",
                        "delivered_amount": "5000",
                    },
                    "tx_json": {
                        "TransactionType": "Payment",
                        "Account": PAYER,
                        "Destination": DEFAULT_PAY_TO,
                        "DeliverMax": "5000",
                        "Fee": "12",
                        "SourceTag": DEFAULT_SOURCE_TAG,
                        "LastLedgerSequence": 1_050,
                        "InvoiceID": hashlib.sha256(b"invoice-1").hexdigest().upper(),
                        "Flags": 0,
                    },
                }
            },
        )

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    reconciliation = asyncio.run(
        verifier.reconcile(receipt, requirement, RESOURCE_INFO, "100", 1_001)
    )
    assert reconciliation == ReconciliationResult("validated", 1_040)
    assert seen == [
        {
            "method": "tx",
            "params": [
                {
                    "transaction": HASH,
                    "binary": False,
                    "api_version": 2,
                }
            ],
        }
    ]


@pytest.mark.parametrize(
    ("field", "value", "error"),
    (
        ("Destination", PAYER, "destination_mismatch"),
        ("DeliverMax", "4999", "amount_mismatch"),
        ("SourceTag", DEFAULT_SOURCE_TAG + 1, "source_tag_mismatch"),
        ("InvoiceID", "B" * 64, "invoice_binding_mismatch"),
        ("Fee", "101", "fee_mismatch"),
    ),
)
def test_ledger_reconciliation_rejects_field_mismatch(
    field: str, value: Any, error: str
) -> None:
    requirement = {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": DEFAULT_PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": DEFAULT_SOURCE_TAG, "invoiceId": "invoice-1"},
    }
    receipt = FixtureReceiptVerifier._receipt(requirement, RESOURCE_INFO, {})
    transaction = {
        "TransactionType": "Payment",
        "Account": PAYER,
        "Destination": DEFAULT_PAY_TO,
        "DeliverMax": "5000",
        "Fee": "12",
        "SourceTag": DEFAULT_SOURCE_TAG,
        "LastLedgerSequence": 1_050,
        "InvoiceID": hashlib.sha256(b"invoice-1").hexdigest().upper(),
        "Flags": 0,
    }
    transaction[field] = value

    def ledger(request: Any) -> Any:
        return httpx.Response(
            200,
            json={
                "result": {
                    "validated": True,
                    "hash": HASH,
                    "ledger_index": 1_040,
                    "meta": {
                        "TransactionResult": "tesSUCCESS",
                        "delivered_amount": "5000",
                    },
                    "tx_json": transaction,
                }
            },
        )

    verifier = T54Facilitator(ledger_transport=httpx.MockTransport(ledger))
    with pytest.raises(VerificationRejected, match=error):
        asyncio.run(
            verifier.reconcile(receipt, requirement, RESOURCE_INFO, "100", 1_001)
        )


def test_merchant_json_bounds_match_harbor_contract() -> None:
    assert_bounded_json(MERCHANT_BODY, require_object=True)
    with pytest.raises(ProtocolError, match="merchant_body_string_too_large"):
        assert_bounded_json({"value": "x" * (MAX_JSON_STRING_BYTES + 1)}, require_object=True)
    with pytest.raises(ProtocolError, match="merchant_body_key_too_large"):
        assert_bounded_json({"x" * (MAX_JSON_KEY_BYTES + 1): True}, require_object=True)
    nested: Any = True
    for _ in range(MAX_JSON_DEPTH):
        nested = {"next": nested}
    with pytest.raises(ProtocolError, match="merchant_body_complexity_exceeded"):
        assert_bounded_json(nested, require_object=True)
    with pytest.raises(ProtocolError, match="merchant_body_must_be_object"):
        assert_bounded_json(["dex", "amm"], require_object=True)
