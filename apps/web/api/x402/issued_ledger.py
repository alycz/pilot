from __future__ import annotations

"""Deterministic offline adapter for native-XRPL issued-currency payments.

The adapter validates real payer-signed XRPL ``Payment`` blobs but never
submits them. Every receipt is explicitly labelled as offline fixture evidence.
"""

import json
import os
import re
import sqlite3
from dataclasses import dataclass, replace
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Optional

from xrpl.core.binarycodec import decode
from xrpl.core.addresscodec import decode_classic_address
from xrpl.core.keypairs import derive_classic_address

from .assets import (
    IssuedCurrencyAsset,
    exact_decimal_compare,
    parse_requirement_asset,
    validate_holder_to_holder,
)
from .verifier import (
    ReconciliationResult,
    SettlementNotAttempted,
    T54Facilitator,
    VerificationReceipt,
    VerificationRejected,
    _approval_envelope_for_payment,
    _inspect_transaction,
    validate_receipt,
)


LSF_REQUIRE_AUTH = 0x0004_0000
LSF_GLOBAL_FREEZE = 0x0040_0000
LSF_DEFAULT_RIPPLE = 0x0080_0000
LSF_REQUIRE_DEST_TAG = 0x0002_0000
LSF_DISABLE_MASTER = 0x0010_0000
LSF_DEPOSIT_AUTH = 0x0100_0000
LSF_LOW_AUTH = 0x0004_0000
LSF_HIGH_AUTH = 0x0008_0000
LSF_LOW_NO_RIPPLE = 0x0010_0000
LSF_HIGH_NO_RIPPLE = 0x0020_0000
LSF_LOW_FREEZE = 0x0040_0000
LSF_HIGH_FREEZE = 0x0080_0000
LSF_LOW_DEEP_FREEZE = 0x0200_0000
LSF_HIGH_DEEP_FREEZE = 0x0400_0000
TRUST_LINE_FREEZE_MASK = (
    LSF_LOW_FREEZE
    | LSF_HIGH_FREEZE
    | LSF_LOW_DEEP_FREEZE
    | LSF_HIGH_DEEP_FREEZE
)
CANONICAL_TRANSFER_RATE = 1_000_000_000
CANONICAL_LEDGER_DECIMAL = re.compile(
    r"^(?:0|-?(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$"
)
NEUTRAL_ISSUER = "rrrrrrrrrrrrrrrrrrrrBZbvji"


@dataclass(frozen=True)
class LedgerSnapshot:
    network: str
    ledger_index: int
    ledger_hash: str
    settlement_ledger_index: int
    account_roots: tuple[Mapping[str, Any], ...]
    ripple_states: tuple[Mapping[str, Any], ...]
    reserve_base_drops: str
    reserve_increment_drops: str
    settlement_status: str = "validated"

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "LedgerSnapshot":
        if value.get("fixtureKind") != "deterministic-offline-ledger-snapshot":
            raise ValueError("ledger fixture provenance is missing")
        if value.get("network") != "xrpl:1":
            raise ValueError("offline issued adapter only supports xrpl:1")
        ledger_index = value.get("ledgerIndex")
        settlement_index = value.get("settlementLedgerIndex")
        ledger_hash = value.get("ledgerHash")
        accounts = value.get("accountRoots")
        lines = value.get("rippleStates")
        reserve = value.get("reserve")
        status = value.get("settlementStatus", "validated")
        if (
            not isinstance(ledger_index, int)
            or ledger_index <= 0
            or not isinstance(settlement_index, int)
            or settlement_index < ledger_index
            or not isinstance(ledger_hash, str)
            or len(ledger_hash) != 64
            or not isinstance(accounts, list)
            or not isinstance(lines, list)
            or not isinstance(reserve, dict)
            or status not in {"validated", "pending", "not_included"}
        ):
            raise ValueError("invalid deterministic ledger fixture")
        base = reserve.get("baseDrops")
        increment = reserve.get("incrementDrops")
        if not _canonical_nonnegative_drops(base) or not _canonical_nonnegative_drops(
            increment
        ):
            raise ValueError("invalid fixture reserve values")
        return cls(
            network="xrpl:1",
            ledger_index=ledger_index,
            ledger_hash=ledger_hash.upper(),
            settlement_ledger_index=settlement_index,
            account_roots=tuple(accounts),
            ripple_states=tuple(lines),
            reserve_base_drops=base,
            reserve_increment_drops=increment,
            settlement_status=status,
        )
    def account(self, address: str) -> Mapping[str, Any]:
        matches = [row for row in self.account_roots if row.get("Account") == address]
        if len(matches) != 1:
            raise VerificationRejected("fixture_account_state_ambiguous")
        row = matches[0]
        if row.get("LedgerEntryType") != "AccountRoot":
            raise VerificationRejected("fixture_account_state_invalid")
        return row

    def trust_line(
        self, holder: str, asset: IssuedCurrencyAsset
    ) -> Mapping[str, Any]:
        matches: list[Mapping[str, Any]] = []
        for row in self.ripple_states:
            low = row.get("LowLimit")
            high = row.get("HighLimit")
            if not isinstance(low, dict) or not isinstance(high, dict):
                continue
            if {low.get("issuer"), high.get("issuer")} != {holder, asset.issuer}:
                continue
            try:
                if decode_classic_address(low["issuer"]) >= decode_classic_address(
                    high["issuer"]
                ):
                    raise VerificationRejected("trust_line_account_order_invalid")
            except (KeyError, ValueError) as exc:
                raise VerificationRejected("trust_line_account_order_invalid") from exc
            if low.get("currency") == asset.currency and high.get("currency") == asset.currency:
                balance = row.get("Balance")
                if (
                    not isinstance(balance, dict)
                    or balance.get("currency") != asset.currency
                    or balance.get("issuer") != NEUTRAL_ISSUER
                ):
                    raise VerificationRejected("trust_line_currency_mismatch")
                matches.append(row)
        if len(matches) != 1:
            raise VerificationRejected("trust_line_missing_or_ambiguous")
        return matches[0]


class OfflineFixtureLedgerStore:
    """Persistent hash-keyed state for the deterministic ledger emulator."""

    def __init__(self, path: Path) -> None:
        self._path = path.absolute()
        if self._path.exists() and self._path.is_symlink():
            raise ValueError("offline ledger database must not be a symlink")
        parent = self._path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if parent.is_symlink():
            raise ValueError("offline ledger database directory must not be a symlink")
        try:
            os.chmod(parent, 0o700)
        except OSError:
            pass
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS x402_offline_ledger (
                    transaction_hash TEXT PRIMARY KEY,
                    network TEXT NOT NULL,
                    payer TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    last_ledger_sequence INTEGER NOT NULL,
                    transaction_json TEXT NOT NULL,
                    delivered_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN
                        ('pending', 'validated', 'not_included'))
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS x402_offline_sequence_locks (
                    network TEXT NOT NULL,
                    payer TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    transaction_hash TEXT NOT NULL UNIQUE,
                    PRIMARY KEY(network, payer, sequence)
                )
                """
            )
        os.chmod(self._path, 0o600)

    def _connect(self) -> sqlite3.Connection:
        if self._path.is_symlink():
            raise ValueError("offline ledger database must not be a symlink")
        connection = sqlite3.connect(str(self._path), timeout=5.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        return connection

    def assert_sequence_available(
        self, *, network: str, payer: str, sequence: int, transaction_hash: str
    ) -> None:
        """Reject known duplicate sequence use before budget reservation.

        ``submit`` repeats this check atomically with insertion to close the
        race between verification and settlement.
        """

        with self._connect() as connection:
            owner = connection.execute(
                """
                SELECT transaction_hash FROM x402_offline_sequence_locks
                WHERE network = ? AND payer = ? AND sequence = ?
                """,
                (network, payer, sequence),
            ).fetchone()
        if owner is not None and owner["transaction_hash"] != transaction_hash:
            raise SettlementNotAttempted("payer_sequence_already_reserved")

    def submit(
        self,
        receipt: VerificationReceipt,
        transaction: Mapping[str, Any],
        asset: IssuedCurrencyAsset,
        status: str,
    ) -> None:
        if status not in {"pending", "validated", "not_included"}:
            raise VerificationRejected("fixture_settlement_status_invalid")
        sequence = transaction.get("Sequence")
        if not isinstance(sequence, int) or sequence <= 0:
            raise VerificationRejected("invalid_sequence")
        # Signatures and public keys are intentionally not persisted. The hash
        # is bound to the already verified signed blob, while the stored ledger
        # projection contains only fields needed for reconciliation.
        projected = {
            key: value
            for key, value in transaction.items()
            if key not in {"SigningPubKey", "TxnSignature"}
        }
        delivered = {
            "currency": asset.currency,
            "issuer": asset.issuer,
            "value": receipt.amount_drops,
        }
        transaction_json = json.dumps(projected, sort_keys=True, separators=(",", ":"))
        delivered_json = json.dumps(delivered, sort_keys=True, separators=(",", ":"))
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM x402_offline_ledger WHERE transaction_hash = ?",
                (receipt.transaction,),
            ).fetchone()
            if existing is not None:
                connection.execute("COMMIT")
                if (
                    existing["network"] != receipt.network
                    or existing["payer"] != receipt.payer
                    or existing["sequence"] != sequence
                    or existing["last_ledger_sequence"] != receipt.last_ledger_sequence
                    or existing["transaction_json"] != transaction_json
                    or existing["delivered_json"] != delivered_json
                ):
                    raise VerificationRejected("fixture_transaction_binding_conflict")
                return
            sequence_owner = connection.execute(
                """
                SELECT transaction_hash FROM x402_offline_sequence_locks
                WHERE network = ? AND payer = ? AND sequence = ?
                """,
                (receipt.network, receipt.payer, sequence),
            ).fetchone()
            if sequence_owner is not None:
                connection.execute("COMMIT")
                raise SettlementNotAttempted("payer_sequence_already_reserved")
            connection.execute(
                """
                INSERT INTO x402_offline_ledger (
                    transaction_hash, network, payer, sequence,
                    last_ledger_sequence, transaction_json, delivered_json, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    receipt.transaction,
                    receipt.network,
                    receipt.payer,
                    sequence,
                    receipt.last_ledger_sequence,
                    transaction_json,
                    delivered_json,
                    status,
                ),
            )
            connection.execute(
                """
                INSERT INTO x402_offline_sequence_locks (
                    network, payer, sequence, transaction_hash
                ) VALUES (?, ?, ?, ?)
                """,
                (receipt.network, receipt.payer, sequence, receipt.transaction),
            )
            connection.execute("COMMIT")

    def result(
        self, transaction_hash: str, snapshot: LedgerSnapshot
    ) -> tuple[str, Optional[Mapping[str, Any]]]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM x402_offline_ledger WHERE transaction_hash = ?",
                (transaction_hash,),
            ).fetchone()
            if row is None:
                connection.execute("COMMIT")
                raise VerificationRejected("fixture_transaction_not_submitted")
            status = row["status"]
            if status == "pending" and snapshot.settlement_status != "pending":
                status = snapshot.settlement_status
                connection.execute(
                    "UPDATE x402_offline_ledger SET status = ? WHERE transaction_hash = ?",
                    (status, transaction_hash),
                )
            if (
                status == "not_included"
                and snapshot.settlement_ledger_index > row["last_ledger_sequence"]
            ):
                connection.execute(
                    """
                    DELETE FROM x402_offline_sequence_locks
                    WHERE transaction_hash = ?
                    """,
                    (transaction_hash,),
                )
            connection.execute("COMMIT")
        if status != "validated":
            return status, None
        return status, {
            "validated": True,
            "hash": transaction_hash,
            "ledger_index": snapshot.settlement_ledger_index,
            "tx_json": json.loads(row["transaction_json"]),
            "meta": {
                "TransactionResult": "tesSUCCESS",
                "delivered_amount": json.loads(row["delivered_json"]),
            },
        }


def _canonical_nonnegative_drops(value: Any) -> bool:
    return isinstance(value, str) and value.isdigit() and (
        value == "0" or not value.startswith("0")
    )


def _as_decimal(value: Any, code: str) -> Decimal:
    if not isinstance(value, str) or not CANONICAL_LEDGER_DECIMAL.fullmatch(value):
        raise VerificationRejected(code)
    try:
        parsed = Decimal(value)
    except Exception as exc:
        raise VerificationRejected(code) from exc
    significant = len(value.lstrip("-").replace(".", "").lstrip("0"))
    if not parsed.is_finite() or significant > 15:
        raise VerificationRejected(code)
    return parsed


def _holder_line_values(
    line: Mapping[str, Any], holder: str, issuer: str
) -> tuple[Decimal, Decimal, bool]:
    low = line.get("LowLimit")
    high = line.get("HighLimit")
    balance = line.get("Balance")
    flags = line.get("Flags")
    if (
        line.get("LedgerEntryType") != "RippleState"
        or not isinstance(low, dict)
        or not isinstance(high, dict)
        or not isinstance(balance, dict)
        or not isinstance(flags, int)
        or flags < 0
    ):
        raise VerificationRejected("trust_line_state_invalid")
    low_address = low.get("issuer")
    high_address = high.get("issuer")
    if {low_address, high_address} != {holder, issuer}:
        raise VerificationRejected("trust_line_identity_mismatch")
    raw_balance = _as_decimal(balance.get("value"), "trust_line_balance_invalid")
    if holder == low_address:
        return (
            raw_balance,
            _as_decimal(low.get("value"), "trust_line_limit_invalid"),
            bool(flags & LSF_HIGH_AUTH),
        )
    return (
        -raw_balance,
        _as_decimal(high.get("value"), "trust_line_limit_invalid"),
        bool(flags & LSF_LOW_AUTH),
    )


def _validate_trust_line_policy(
    line: Mapping[str, Any], issuer: str
) -> None:
    low = line["LowLimit"]
    high = line["HighLimit"]
    flags = line["Flags"]
    issuer_no_ripple = (
        LSF_LOW_NO_RIPPLE if low.get("issuer") == issuer else LSF_HIGH_NO_RIPPLE
    )
    if flags & issuer_no_ripple:
        raise VerificationRejected("issuer_trust_line_no_ripple")
    for name in ("LowQualityIn", "LowQualityOut", "HighQualityIn", "HighQualityOut"):
        if line.get(name, 0) not in {0, CANONICAL_TRANSFER_RATE}:
            raise VerificationRejected("trust_line_quality_unsupported")


def validate_issued_preflight(
    transaction: Mapping[str, Any],
    requirement: Mapping[str, Any],
    snapshot: LedgerSnapshot,
) -> str:
    asset = parse_requirement_asset(requirement)
    if not isinstance(asset, IssuedCurrencyAsset):
        raise VerificationRejected("issued_asset_required")
    if requirement.get("network") != snapshot.network:
        raise VerificationRejected("ledger_network_mismatch")
    payer = transaction.get("Account")
    pay_to = transaction.get("Destination")
    if not isinstance(payer, str) or not isinstance(pay_to, str):
        raise VerificationRejected("payment_accounts_invalid")
    try:
        validate_holder_to_holder(asset, payer, pay_to)
    except ValueError as exc:
        raise VerificationRejected("holder_to_holder_required") from exc

    issuer = snapshot.account(asset.issuer)
    payer_root = snapshot.account(payer)
    destination_root = snapshot.account(pay_to)
    issuer_flags = issuer.get("Flags")
    if not isinstance(issuer_flags, int):
        raise VerificationRejected("issuer_state_invalid")
    if issuer_flags & LSF_GLOBAL_FREEZE:
        raise VerificationRejected("issuer_global_freeze")
    if issuer_flags & LSF_REQUIRE_AUTH:
        raise VerificationRejected("issuer_require_auth_unsupported")
    if not issuer_flags & LSF_DEFAULT_RIPPLE:
        raise VerificationRejected("issuer_default_ripple_required")
    if issuer.get("TransferRate", CANONICAL_TRANSFER_RATE) != CANONICAL_TRANSFER_RATE:
        raise VerificationRejected("issuer_transfer_fee_unsupported")
    destination_flags = destination_root.get("Flags")
    if not isinstance(destination_flags, int):
        raise VerificationRejected("destination_state_invalid")
    if destination_flags & LSF_DEPOSIT_AUTH:
        raise VerificationRejected("destination_deposit_auth_unsupported")
    if (
        destination_flags & LSF_REQUIRE_DEST_TAG
        and "destinationTag" not in requirement["extra"]
    ):
        raise VerificationRejected("destination_tag_required")

    payer_line = snapshot.trust_line(payer, asset)
    destination_line = snapshot.trust_line(pay_to, asset)
    for line in (payer_line, destination_line):
        flags = line.get("Flags")
        if not isinstance(flags, int) or flags & TRUST_LINE_FREEZE_MASK:
            raise VerificationRejected("trust_line_frozen")
        _validate_trust_line_policy(line, asset.issuer)
    payer_balance, _, payer_authorized = _holder_line_values(
        payer_line, payer, asset.issuer
    )
    destination_balance, destination_limit, destination_authorized = (
        _holder_line_values(destination_line, pay_to, asset.issuer)
    )
    if payer_authorized or destination_authorized:
        raise VerificationRejected("unexpected_trust_line_authorization")
    if exact_decimal_compare(str(payer_balance), requirement["amount"]) < 0:
        raise VerificationRejected("insufficient_issued_balance")
    if exact_decimal_compare(
        str(destination_limit - destination_balance), requirement["amount"]
    ) < 0:
        raise VerificationRejected("destination_trust_line_limit")
    if transaction.get("Sequence") != payer_root.get("Sequence"):
        raise VerificationRejected("account_sequence_mismatch")
    payer_flags = payer_root.get("Flags")
    if not isinstance(payer_flags, int):
        raise VerificationRejected("payer_state_invalid")
    signing_public_key = transaction.get("SigningPubKey")
    if not isinstance(signing_public_key, str):
        raise VerificationRejected("signing_key_invalid")
    try:
        signer_address = derive_classic_address(signing_public_key)
    except Exception as exc:
        raise VerificationRejected("signing_key_invalid") from exc
    if signer_address == payer and payer_flags & LSF_DISABLE_MASTER:
        raise VerificationRejected("payer_master_key_disabled")
    if signer_address != payer and signer_address != payer_root.get("RegularKey"):
        raise VerificationRejected("signing_key_not_authorized")
    fee = transaction.get("Fee")
    balance_drops = payer_root.get("Balance")
    owner_count = payer_root.get("OwnerCount")
    if (
        not _canonical_nonnegative_drops(fee)
        or not _canonical_nonnegative_drops(balance_drops)
        or not isinstance(owner_count, int)
        or owner_count < 0
    ):
        raise VerificationRejected("payer_xrp_state_invalid")
    minimum_reserve = int(snapshot.reserve_base_drops) + owner_count * int(
        snapshot.reserve_increment_drops
    )
    if int(balance_drops) - int(fee) < minimum_reserve:
        raise VerificationRejected("insufficient_xrp_fee_or_reserve")
    return balance_drops


class OfflineIssuedCurrencyFacilitator:
    fixture_only = True

    def __init__(self, snapshot: LedgerSnapshot, state_path: Path) -> None:
        self.snapshot = snapshot
        self._ledger = OfflineFixtureLedgerStore(state_path)
        self._transactions: dict[str, Mapping[str, Any]] = {}

    async def current_validated_ledger(self) -> int:
        return self.snapshot.ledger_index

    async def verify(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        try:
            signed_blob = payment_payload["payload"]["signedTxBlob"]
        except (KeyError, TypeError) as exc:
            raise VerificationRejected("invalid_signed_tx_blob") from exc
        if not isinstance(signed_blob, str):
            raise VerificationRejected("invalid_signed_tx_blob")
        receipt = _inspect_transaction(
            signed_blob,
            payment_requirement,
            _approval_envelope_for_payment(payment_payload, payment_requirement),
            resource,
        )
        try:
            transaction = decode(signed_blob)
        except Exception as exc:
            raise VerificationRejected("invalid_signed_tx_blob") from exc
        payer_balance = validate_issued_preflight(
            transaction, payment_requirement, self.snapshot
        )
        self._ledger.assert_sequence_available(
            network=receipt.network,
            payer=receipt.payer,
            sequence=transaction["Sequence"],
            transaction_hash=receipt.transaction,
        )
        self._transactions[receipt.transaction] = transaction
        return replace(
            receipt,
            resource_url=resource["url"],
            evidence_source="deterministic-offline-fixture",
            payer_xrp_balance_drops=payer_balance,
        )

    async def settle(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        receipt = await self.verify(payment_payload, payment_requirement, resource)
        transaction = self._transactions[receipt.transaction]
        asset = parse_requirement_asset(payment_requirement)
        assert isinstance(asset, IssuedCurrencyAsset)
        self._ledger.submit(
            receipt, transaction, asset, self.snapshot.settlement_status
        )
        return receipt

    async def reconcile(
        self,
        receipt: VerificationReceipt,
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
        max_fee_drops: str,
        first_ledger_sequence: Optional[int],
    ) -> ReconciliationResult:
        validate_receipt(
            receipt,
            requirement=payment_requirement,
            resource=resource,
            max_fee_drops=max_fee_drops,
            first_ledger_sequence=first_ledger_sequence,
        )
        status, result = self._ledger.result(receipt.transaction, self.snapshot)
        if status == "pending":
            return ReconciliationResult("pending")
        if status == "not_included":
            if self.snapshot.settlement_ledger_index <= receipt.last_ledger_sequence:
                return ReconciliationResult("pending")
            return ReconciliationResult(
                "not_included", self.snapshot.settlement_ledger_index
            )
        assert result is not None
        return T54Facilitator._validate_ledger_payment(
            result,
            receipt,
            payment_requirement,
            max_fee_drops,
            legacy_presence_only=False,
            first_ledger_sequence=first_ledger_sequence,
        )
