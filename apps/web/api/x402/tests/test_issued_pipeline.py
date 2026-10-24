from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from xrpl.core.binarycodec import decode, encode
from xrpl.core.addresscodec import decode_classic_address
from xrpl.models.transactions import Payment
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from apps.web.api.x402.assets import (
    IssuedCurrencyAsset,
    asset_identity_key,
)
from apps.web.api.x402.approval import (
    APPROVAL_EXTENSION_KEY,
    approval_extension_offer,
    digest_issued_approval_envelope,
)
from apps.web.api.x402.budget import BudgetLimits, IssuedAssetBudgetLedger
from apps.web.api.x402.config import MerchantConfig, RESOURCE_PATH
from apps.web.api.x402.issued_compare import (
    ISSUED_FIXTURE_BODY,
    ISSUED_MERCHANT_ID,
    create_offline_issued_app,
)
from apps.web.api.x402.issued_ledger import (
    LSF_GLOBAL_FREEZE,
    LSF_HIGH_DEEP_FREEZE,
    LSF_DEPOSIT_AUTH,
    LSF_DISABLE_MASTER,
    LSF_HIGH_NO_RIPPLE,
    LSF_LOW_NO_RIPPLE,
    LSF_REQUIRE_AUTH,
    LedgerSnapshot,
)
from apps.web.api.x402.protocol import decode_payment_header, encode_header
from apps.web.api.x402.verifier import T54Facilitator, VerificationRejected


CURRENCY = "524C555344000000000000000000000000000000"


def _fixture_mapping() -> dict[str, Any]:
    return json.loads(
        (Path(__file__).parent / "fixtures" / "xrpl_issued_rlusd_validated.json")
        .read_text(encoding="utf-8")
    )


def _snapshot(payer: str, pay_to: str, issuer: str, **changes: Any) -> LedgerSnapshot:
    fixture = _fixture_mapping()
    fixture["accountRoots"][0]["Account"] = issuer
    fixture["accountRoots"][1]["Account"] = payer
    fixture["accountRoots"][2]["Account"] = pay_to
    def bind_line(line: dict[str, Any], holder: str, balance: str) -> None:
        holder_is_low = decode_classic_address(holder) < decode_classic_address(issuer)
        low, high = (holder, issuer) if holder_is_low else (issuer, holder)
        line["LowLimit"]["issuer"] = low
        line["HighLimit"]["issuer"] = high
        line["LowLimit"]["value"] = "1000" if holder_is_low else "0"
        line["HighLimit"]["value"] = "0" if holder_is_low else "1000"
        line["Balance"]["value"] = (
            balance if holder_is_low or balance == "0" else f"-{balance}"
        )

    bind_line(fixture["rippleStates"][0], payer, "100")
    bind_line(fixture["rippleStates"][1], pay_to, "0")
    for key, value in changes.items():
        if key == "issuer_flags":
            fixture["accountRoots"][0]["Flags"] = value
        elif key == "transfer_rate":
            fixture["accountRoots"][0]["TransferRate"] = value
        elif key == "payer_line_flags":
            fixture["rippleStates"][0]["Flags"] = value
        elif key == "destination_flags":
            fixture["accountRoots"][2]["Flags"] = value
        elif key == "payer_flags":
            fixture["accountRoots"][1]["Flags"] = value
        elif key == "payer_regular_key":
            fixture["accountRoots"][1]["RegularKey"] = value
        elif key == "issuer_no_ripple":
            line = fixture["rippleStates"][0]
            issuer_is_low = line["LowLimit"]["issuer"] == issuer
            line["Flags"] |= (
                LSF_LOW_NO_RIPPLE if issuer_is_low else LSF_HIGH_NO_RIPPLE
            )
        elif key == "trust_line_quality":
            fixture["rippleStates"][0]["HighQualityOut"] = value
        elif key == "remove_payer_line":
            fixture["rippleStates"] = fixture["rippleStates"][1:]
        elif key == "settlement_status":
            fixture["settlementStatus"] = value
            if value == "not_included":
                # Absence is terminal only after the signed ledger window closes.
                fixture["settlementLedgerIndex"] = 1_015
        else:
            raise AssertionError(f"unknown fixture change: {key}")
    return LedgerSnapshot.from_mapping(fixture)


def _budget(path: Path) -> IssuedAssetBudgetLedger:
    return IssuedAssetBudgetLedger(
        path,
        BudgetLimits(
            asset_per_call="1",
            asset_daily="2",
            asset_lifetime="3",
            fee_per_call_drops="20",
            fee_daily_drops="40",
            fee_lifetime_drops="60",
            minimum_xrp_reserve_drops="1200000",
        ),
        enabled=True,
        clock=lambda: datetime(2026, 10, 24, 12, tzinfo=timezone.utc),
    )


def _config(path: Path, pay_to: str) -> MerchantConfig:
    return MerchantConfig(
        pay_to=pay_to,
        price_drops="5000",
        source_tag=2_610_240,
        max_timeout_seconds=60,
        max_payer_fee_drops="20",
        invoice_db_path=path,
    )


def _client(app: Any) -> TestClient:
    return TestClient(
        app,
        base_url="http://127.0.0.1:8000",
        client=("127.0.0.1", 50_000),
    )


def _signed_header(
    challenge: Mapping[str, Any],
    payer: Wallet,
    *,
    account: str | None = None,
    transaction_patch: Mapping[str, Any] | None = None,
    approval_patch: Mapping[str, Any] | None = None,
    invoice_contract: str = "semantic",
    include_approval_extension: bool = True,
) -> str:
    requirement = challenge["accepts"][0]
    extra = requirement["extra"]
    amount = {
        "currency": requirement["asset"],
        "issuer": extra["issuer"],
        "value": requirement["amount"],
    }
    fields: dict[str, Any] = {
        "account": account or payer.classic_address,
        "destination": requirement["payTo"],
        "amount": amount,
        "send_max": dict(amount),
        "fee": "12",
        "sequence": 1,
        "last_ledger_sequence": 1_014,
        "source_tag": extra["sourceTag"],
    }
    fields.update(transaction_patch or {})
    envelope: dict[str, Any] = {
        "version": 1,
        "domain": "pilot.x402.owner-approval",
        "approval_id": f"approval-{extra['invoiceId']}",
        "network": "xrpl:1",
        "execution_network": "testnet",
        "session_scope": "principal-owner-review-0001",
        "idempotency_key": f"payment-{extra['invoiceId']}",
        "merchant": {
            "id": ISSUED_MERCHANT_ID,
            "resource_method": "POST",
            "resource_url": challenge["resource"]["url"],
            "pay_to": requirement["payTo"],
        },
        "asset": {
            "currency": requirement["asset"],
            "issuer": extra["issuer"],
            "kind": "issued",
            "namespace": "token",
            "network": "xrpl:1",
        },
        "amount": requirement["amount"],
        "owner": fields["account"],
        "quote_expires_at": "2026-10-24T12:04:00.000Z",
        "merchant_invoice_id": extra["invoiceId"],
        "transaction": {
            "fee_drops": fields["fee"],
            "last_ledger_sequence": fields["last_ledger_sequence"],
            "sequence": fields["sequence"],
            "source_tag": fields["source_tag"],
            "validated_ledger_index": 1_000,
        },
    }
    envelope.update(approval_patch or {})
    if invoice_contract == "semantic":
        fields["invoice_id"] = digest_issued_approval_envelope(envelope)
    elif invoice_contract == "legacy":
        fields["invoice_id"] = hashlib.sha256(
            extra["invoiceId"].encode("utf-8")
        ).hexdigest().upper()
    else:
        fields["invoice_id"] = invoice_contract
    signed = sign(Payment(**fields), payer)
    payment: dict[str, Any] = {
        "x402Version": 2,
        "resource": challenge["resource"],
        "accepted": requirement,
        "payload": {"signedTxBlob": encode(signed.to_xrpl())},
    }
    if include_approval_extension:
        payment["extensions"] = {
            APPROVAL_EXTENSION_KEY: {"version": 1, "envelope": envelope}
        }
    return encode_header(payment)


def _app(
    tmp_path: Path,
    payer: Wallet,
    payee: Wallet,
    issuer: Wallet,
    *,
    snapshot: LedgerSnapshot | None = None,
    invoice_db: Path | None = None,
    budget_db: Path | None = None,
    ledger_db: Path | None = None,
    invoice_id_factory: Callable[[], str] = lambda: "issued-invoice-1",
    merchant_now: float | None = None,
) -> Any:
    asset = IssuedCurrencyAsset(CURRENCY, issuer.classic_address)
    fixed_now = datetime(2026, 10, 24, 12, tzinfo=timezone.utc).timestamp()
    return create_offline_issued_app(
        config=_config(invoice_db or tmp_path / "invoices.sqlite3", payee.classic_address),
        asset=asset,
        amount="0.01",
        asset_allowlist={asset_identity_key(asset)},
        snapshot=snapshot or _snapshot(
            payer.classic_address, payee.classic_address, issuer.classic_address
        ),
        budget=_budget(budget_db or tmp_path / "budget.sqlite3"),
        ledger_state_path=ledger_db or tmp_path / "offline-ledger.sqlite3",
        clock=lambda: fixed_now if merchant_now is None else merchant_now,
        invoice_id_factory=invoice_id_factory,
    )


def test_issued_route_challenge_signed_payment_reconcile_and_cached_retry(
    tmp_path: Path,
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    with _client(_app(tmp_path, payer, payee, issuer)) as client:
        challenge_response = client.get(RESOURCE_PATH)
        assert challenge_response.status_code == 402
        challenge = challenge_response.json()
        assert decode_payment_header(
            challenge_response.headers["payment-required"]
        ) == challenge
        requirement = challenge["accepts"][0]
        assert challenge["extensions"] == approval_extension_offer()
        assert requirement == {
            "scheme": "exact",
            "network": "xrpl:1",
            "asset": CURRENCY,
            "payTo": payee.classic_address,
            "amount": "0.01",
            "maxTimeoutSeconds": 60,
            "extra": {
                "areFeesSponsored": False,
                "assetTransferMethod": "sequence",
                "issuer": issuer.classic_address,
                "sourceTag": 2_610_240,
                "invoiceId": "issued-invoice-1",
            },
        }
        signature = _signed_header(challenge, payer)
        wrong_method = client.get(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
        paid = client.post(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
        replay = client.post(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
    assert wrong_method.status_code == 405
    assert wrong_method.json() == {"error": "resource_method_mismatch"}
    assert paid.status_code == replay.status_code == 200
    assert paid.json() == replay.json() == ISSUED_FIXTURE_BODY
    assert paid.headers["payment-response"] == replay.headers["payment-response"]
    assert decode_payment_header(paid.headers["payment-response"])[
        "evidenceSource"
    ] == "deterministic-offline-fixture"


def test_issued_route_rejects_legacy_raw_invoice_hash_and_mixed_contracts(
    tmp_path: Path,
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    invoice_ids = iter(
        (
            "legacy-invoice-1",
            "missing-envelope-1",
            "mixed-envelope-1",
            "stale-envelope-1",
        )
    )
    with _client(
        _app(
            tmp_path,
            payer,
            payee,
            issuer,
            invoice_id_factory=lambda: next(invoice_ids),
        )
    ) as client:
        legacy_challenge = client.get(RESOURCE_PATH).json()
        legacy = client.post(
            RESOURCE_PATH,
            headers={
                "PAYMENT-SIGNATURE": _signed_header(
                    legacy_challenge, payer, invoice_contract="legacy"
                )
            },
        )
        missing_challenge = client.get(RESOURCE_PATH).json()
        missing = client.post(
            RESOURCE_PATH,
            headers={
                "PAYMENT-SIGNATURE": _signed_header(
                    missing_challenge,
                    payer,
                    include_approval_extension=False,
                )
            },
        )
        mixed_challenge = client.get(RESOURCE_PATH).json()
        mixed = client.post(
            RESOURCE_PATH,
            headers={
                "PAYMENT-SIGNATURE": _signed_header(
                    mixed_challenge,
                    payer,
                    approval_patch={"approval_digest": "A" * 64},
                )
            },
        )
        stale_challenge = client.get(RESOURCE_PATH).json()
        stale = client.post(
            RESOURCE_PATH,
            headers={
                "PAYMENT-SIGNATURE": _signed_header(
                    stale_challenge,
                    payer,
                    approval_patch={
                        "quote_expires_at": "2026-10-24T11:59:59.999Z"
                    },
                )
            },
        )

    assert legacy.status_code == 402
    assert legacy.json() == {"error": "legacy_raw_invoice_hash_rejected"}
    assert missing.status_code == 402
    assert missing.json() == {"error": "semantic_approval_envelope_required"}
    assert mixed.status_code == 402
    assert mixed.json() == {"error": "invalid_semantic_approval_envelope"}
    assert stale.status_code == 402
    assert stale.json() == {"error": "semantic_approval_expired_or_unbounded"}


@pytest.mark.parametrize(
    ("change", "value", "error"),
    (
        ("issuer_flags", LSF_GLOBAL_FREEZE | 0x0080_0000, "issuer_global_freeze"),
        ("issuer_flags", LSF_REQUIRE_AUTH | 0x0080_0000, "issuer_require_auth_unsupported"),
        ("transfer_rate", 1_010_000_000, "issuer_transfer_fee_unsupported"),
        ("payer_line_flags", LSF_HIGH_DEEP_FREEZE, "trust_line_frozen"),
        ("destination_flags", LSF_DEPOSIT_AUTH, "destination_deposit_auth_unsupported"),
        ("issuer_no_ripple", True, "issuer_trust_line_no_ripple"),
        ("trust_line_quality", 999_000_000, "trust_line_quality_unsupported"),
        ("remove_payer_line", True, "trust_line_missing_or_ambiguous"),
    ),
)
def test_preflight_fails_closed_on_issuer_and_trustline_edges(
    tmp_path: Path, change: str, value: Any, error: str
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    snapshot = _snapshot(
        payer.classic_address,
        payee.classic_address,
        issuer.classic_address,
        **{change: value},
    )
    with _client(_app(tmp_path, payer, payee, issuer, snapshot=snapshot)) as client:
        challenge = client.get(RESOURCE_PATH).json()
        response = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(challenge, payer)},
        )
    assert response.status_code == 402
    assert response.json() == {"error": error}


@pytest.mark.parametrize(
    ("patch_kind", "error"),
    (
        ("partial", "partial_payment_forbidden"),
        ("unsupported_flag", "unsupported_payment_flag"),
        ("paths", "unsupported_payment_field"),
        ("wrong_send_max", "issued_send_max_mismatch"),
        ("larger_send_max", "issued_send_max_mismatch"),
        ("long_expiry", "semantic_approval_transaction_mismatch"),
    ),
)
def test_unsafe_transaction_controls_and_expiry_are_rejected_before_budget(
    tmp_path: Path, patch_kind: str, error: str
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    app = _app(tmp_path, payer, payee, issuer)
    with _client(app) as client:
        partial_challenge = client.get(RESOURCE_PATH).json()
        requirement = partial_challenge["accepts"][0]
        patches: dict[str, Mapping[str, Any]] = {
            "partial": {"flags": 0x0002_0000},
            "unsupported_flag": {"flags": 0x0004_0000},
            "paths": {"paths": [[{"account": issuer.classic_address}]]},
            "wrong_send_max": {
                "send_max": {
                    "currency": requirement["asset"],
                    "issuer": payee.classic_address,
                    "value": requirement["amount"],
                }
            },
            "larger_send_max": {
                "send_max": {
                    "currency": requirement["asset"],
                    "issuer": requirement["extra"]["issuer"],
                    "value": "0.02",
                }
            },
            "long_expiry": {"last_ledger_sequence": 2_000},
        }
        partial = client.post(
            RESOURCE_PATH,
            headers={
                "PAYMENT-SIGNATURE": _signed_header(
                    partial_challenge, payer, transaction_patch=patches[patch_kind]
                )
            },
        )
    assert partial.status_code == 402
    assert partial.json() == {"error": error}


def test_pending_settlement_reconciles_after_restart_without_second_payment(
    tmp_path: Path,
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    invoice_db = tmp_path / "restart-invoices.sqlite3"
    budget_db = tmp_path / "restart-budget.sqlite3"
    ledger_db = tmp_path / "restart-ledger.sqlite3"
    pending = _snapshot(
        payer.classic_address,
        payee.classic_address,
        issuer.classic_address,
        settlement_status="pending",
    )
    with _client(
        _app(
            tmp_path,
            payer,
            payee,
            issuer,
            snapshot=pending,
            invoice_db=invoice_db,
            budget_db=budget_db,
            ledger_db=ledger_db,
        )
    ) as client:
        challenge = client.get(RESOURCE_PATH).json()
        signature = _signed_header(challenge, payer)
        first = client.post(RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature})
    assert first.status_code == 503
    assert first.json()["settlementAttempted"] is True
    signed_transaction = decode(
        decode_payment_header(signature)["payload"]["signedTxBlob"]
    )
    with sqlite3.connect(invoice_db) as connection:
        persisted = connection.execute(
            "SELECT verified_receipt_json FROM x402_invoices "
            "WHERE invoice_id = 'issued-invoice-1'"
        ).fetchone()
    assert persisted is not None
    persisted_receipt = json.loads(persisted[0])
    assert persisted_receipt["invoice_id"] == "issued-invoice-1"
    assert persisted_receipt["approval_digest"] == signed_transaction["InvoiceID"]

    validated = replace(pending, settlement_status="validated")
    after_quote_expiry = datetime(
        2026, 10, 24, 12, 10, tzinfo=timezone.utc
    ).timestamp()
    with _client(
        _app(
            tmp_path,
            payer,
            payee,
            issuer,
            snapshot=validated,
            invoice_db=invoice_db,
            budget_db=budget_db,
            ledger_db=ledger_db,
            merchant_now=after_quote_expiry,
        )
    ) as restarted:
        recovered = restarted.post(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
        cached = restarted.post(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert recovered.status_code == cached.status_code == 200
    assert recovered.json() == cached.json() == ISSUED_FIXTURE_BODY


@pytest.mark.parametrize(
    "delivered",
    (
        "unavailable",
        "10000",
        "wrong-issuer",
        "wrong-value",
    ),
)
def test_reconciliation_rejects_nonexact_delivered_amount_fixture(
    tmp_path: Path, delivered: Any
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    app = _app(tmp_path, payer, payee, issuer)
    with _client(app) as client:
        challenge = client.get(RESOURCE_PATH).json()
    payment_header = _signed_header(challenge, payer)
    payload = decode_payment_header(payment_header)
    requirement = challenge["accepts"][0]
    if delivered == "wrong-issuer":
        delivered = {
            "currency": CURRENCY,
            "issuer": payee.classic_address,
            "value": "0.01",
        }
    elif delivered == "wrong-value":
        delivered = {
            "currency": CURRENCY,
            "issuer": issuer.classic_address,
            "value": "0.02",
        }
    verifier = app.state.x402_service.verifier
    receipt = asyncio.run(verifier.verify(payload, requirement, challenge["resource"]))
    transaction = verifier._transactions[receipt.transaction]
    result = {
        "validated": True,
        "hash": receipt.transaction,
        "ledger_index": 1001,
        "tx_json": transaction,
        "meta": {"TransactionResult": "tesSUCCESS", "delivered_amount": delivered},
    }
    with pytest.raises(VerificationRejected, match="ledger_delivered_amount_mismatch"):
        T54Facilitator._validate_ledger_payment(
            result,
            receipt,
            requirement,
            "20",
            legacy_presence_only=False,
            first_ledger_sequence=1001,
        )


def test_fixture_contains_no_secret_or_signed_payment_material() -> None:
    text = (
        Path(__file__).parent / "fixtures" / "xrpl_issued_rlusd_validated.json"
    ).read_text(encoding="utf-8")
    lowered = text.lower()
    for forbidden in ("seed", "secret", "privatekey", "signedtxblob", "txnsignature"):
        assert forbidden not in lowered
    assert "offline fixture only" in lowered


def test_two_invoices_cannot_reuse_one_payer_sequence(tmp_path: Path) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    invoice_ids = iter(("sequence-invoice-1", "sequence-invoice-2"))
    app = _app(
        tmp_path,
        payer,
        payee,
        issuer,
        invoice_id_factory=lambda: next(invoice_ids),
    )
    with _client(app) as client:
        first_challenge = client.get(RESOURCE_PATH).json()
        first = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(first_challenge, payer)},
        )
        second_challenge = client.get(RESOURCE_PATH).json()
        second = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(second_challenge, payer)},
        )
        second_replay = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(second_challenge, payer)},
        )
    assert first.status_code == 200
    assert second.status_code == second_replay.status_code == 402
    assert second.json() == second_replay.json() == {
        "error": "payer_sequence_already_reserved"
    }
    with sqlite3.connect(tmp_path / "budget.sqlite3") as connection:
        second_budget_state = connection.execute(
            """
            SELECT state FROM x402_issued_budget
            WHERE invoice_id = 'sequence-invoice-2'
            """
        ).fetchone()
    assert second_budget_state is None


def test_atomic_sequence_race_loser_is_terminal_and_releases_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    invoice_ids = iter(("race-invoice-1", "race-invoice-2"))
    app = _app(
        tmp_path,
        payer,
        payee,
        issuer,
        invoice_id_factory=lambda: next(invoice_ids),
    )
    verifier = app.state.x402_service.verifier
    monkeypatch.setattr(
        verifier._ledger,
        "assert_sequence_available",
        lambda **_: None,
    )
    with _client(app) as client:
        first_challenge = client.get(RESOURCE_PATH).json()
        first = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(first_challenge, payer)},
        )
        second_challenge = client.get(RESOURCE_PATH).json()
        second_signature = _signed_header(second_challenge, payer)
        second = client.post(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": second_signature}
        )
        replay = client.post(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": second_signature}
        )
    expected = {
        "error": "payer_sequence_already_reserved",
        "retryable": False,
        "phase": "settle",
        "settlementAttempted": False,
    }
    assert first.status_code == 200
    assert second.status_code == replay.status_code == 402
    assert second.json() == replay.json() == expected
    with sqlite3.connect(tmp_path / "budget.sqlite3") as connection:
        budget_state = connection.execute(
            """
            SELECT state FROM x402_issued_budget
            WHERE invoice_id = 'race-invoice-2'
            """
        ).fetchone()
    with sqlite3.connect(tmp_path / "invoices.sqlite3") as connection:
        invoice_state = connection.execute(
            """
            SELECT state FROM x402_invoices
            WHERE invoice_id = 'race-invoice-2'
            """
        ).fetchone()
    assert budget_state == ("released",)
    assert invoice_state == ("rejected",)


def test_signature_must_authorize_the_account_master_or_regular_key(
    tmp_path: Path,
) -> None:
    owner, attacker, payee, issuer = (
        Wallet.create(), Wallet.create(), Wallet.create(), Wallet.create()
    )
    base = _snapshot(owner.classic_address, payee.classic_address, issuer.classic_address)
    with _client(_app(tmp_path / "wrong", owner, payee, issuer, snapshot=base)) as client:
        challenge = client.get(RESOURCE_PATH).json()
        wrong_key = client.post(
            RESOURCE_PATH,
            headers={
                "PAYMENT-SIGNATURE": _signed_header(
                    challenge, attacker, account=owner.classic_address
                )
            },
        )
    assert wrong_key.status_code == 402
    assert wrong_key.json() == {"error": "signing_key_not_authorized"}

    disabled = _snapshot(
        owner.classic_address,
        payee.classic_address,
        issuer.classic_address,
        payer_flags=LSF_DISABLE_MASTER,
    )
    with _client(_app(tmp_path / "disabled", owner, payee, issuer, snapshot=disabled)) as client:
        challenge = client.get(RESOURCE_PATH).json()
        disabled_master = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(challenge, owner)},
        )
    assert disabled_master.status_code == 402
    assert disabled_master.json() == {"error": "payer_master_key_disabled"}

    regular = _snapshot(
        owner.classic_address,
        payee.classic_address,
        issuer.classic_address,
        payer_flags=LSF_DISABLE_MASTER,
        payer_regular_key=attacker.classic_address,
    )
    with _client(_app(tmp_path / "regular", owner, payee, issuer, snapshot=regular)) as client:
        challenge = client.get(RESOURCE_PATH).json()
        regular_key = client.post(
            RESOURCE_PATH,
            headers={
                "PAYMENT-SIGNATURE": _signed_header(
                    challenge, attacker, account=owner.classic_address
                )
            },
        )
    assert regular_key.status_code == 200


def test_not_included_replay_repairs_budget_release_after_interruption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    snapshot = _snapshot(
        payer.classic_address,
        payee.classic_address,
        issuer.classic_address,
        settlement_status="not_included",
    )
    app = _app(tmp_path, payer, payee, issuer, snapshot=snapshot)
    budget = app.state.x402_service.budget
    original_release = budget.release_not_included
    calls = 0

    def interrupted_once(key: str) -> bool:
        nonlocal calls
        calls += 1
        if calls == 1:
            return False
        return original_release(key)

    monkeypatch.setattr(budget, "release_not_included", interrupted_once)
    with _client(app) as client:
        challenge = client.get(RESOURCE_PATH).json()
        signature = _signed_header(challenge, payer)
        interrupted = client.post(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
        repaired = client.post(
            RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
        )
    assert interrupted.status_code == 503
    assert interrupted.json()["error"] == "budget_release_uncertain"
    assert repaired.status_code == 410
    assert repaired.json()["error"] == "transaction_not_included_before_last_ledger_sequence"


def test_not_included_remains_pending_until_signed_ledger_window_closes(
    tmp_path: Path,
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    snapshot = replace(
        _snapshot(
            payer.classic_address,
            payee.classic_address,
            issuer.classic_address,
            settlement_status="not_included",
        ),
        settlement_ledger_index=1_014,
    )
    with _client(_app(tmp_path, payer, payee, issuer, snapshot=snapshot)) as client:
        challenge = client.get(RESOURCE_PATH).json()
        pending = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(challenge, payer)},
        )
    assert pending.status_code == 503
    assert pending.json()["error"] == "settlement_pending_validation"


def test_proven_not_included_payment_releases_sequence_for_replacement(
    tmp_path: Path,
) -> None:
    payer, payee, issuer = Wallet.create(), Wallet.create(), Wallet.create()
    invoice_ids = iter(("expired-sequence-1", "expired-sequence-2"))
    snapshot = _snapshot(
        payer.classic_address,
        payee.classic_address,
        issuer.classic_address,
        settlement_status="not_included",
    )
    app = _app(
        tmp_path,
        payer,
        payee,
        issuer,
        snapshot=snapshot,
        invoice_id_factory=lambda: next(invoice_ids),
    )
    with _client(app) as client:
        first_challenge = client.get(RESOURCE_PATH).json()
        first = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(first_challenge, payer)},
        )
        second_challenge = client.get(RESOURCE_PATH).json()
        second = client.post(
            RESOURCE_PATH,
            headers={"PAYMENT-SIGNATURE": _signed_header(second_challenge, payer)},
        )
    assert first.status_code == second.status_code == 410
