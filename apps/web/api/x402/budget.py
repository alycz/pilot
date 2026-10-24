from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Callable, Literal

from xrpl.core.addresscodec import is_valid_classic_address

from .assets import IssuedCurrencyAsset, canonical_issued_value


CANONICAL_DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")
CANONICAL_DROPS = re.compile(r"^(?:0|[1-9][0-9]*)$")
COUNTED_STATES = ("reserved", "uncertain", "committed")


class BudgetError(RuntimeError):
    pass


class BudgetDisabled(BudgetError):
    pass


class BudgetConflict(BudgetError):
    pass


class BudgetExceeded(BudgetError):
    pass


class InsufficientXrpReserve(BudgetError):
    pass


def _positive_decimal(name: str, value: str) -> Decimal:
    try:
        parsed = Decimal(canonical_issued_value(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{name} must be a canonical decimal string") from exc
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError(f"{name} must be positive")
    return parsed


def _drops(name: str, value: str, *, positive: bool = False) -> int:
    if not isinstance(value, str) or not CANONICAL_DROPS.fullmatch(value):
        raise ValueError(f"{name} must be a canonical drops string")
    parsed = int(value)
    if positive and parsed <= 0:
        raise ValueError(f"{name} must be positive")
    return parsed


def _identity_part(name: str, value: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{name} must be a non-empty exact string")
    return value


@dataclass(frozen=True)
class IssuedAssetIdentity:
    network: str
    currency: str
    issuer: str

    def __post_init__(self) -> None:
        IssuedCurrencyAsset(
            network=self.network,
            currency=self.currency,
            issuer=self.issuer,
        )


@dataclass(frozen=True)
class BudgetLimits:
    asset_per_call: str
    asset_daily: str
    asset_lifetime: str
    fee_per_call_drops: str
    fee_daily_drops: str
    fee_lifetime_drops: str
    minimum_xrp_reserve_drops: str

    def __post_init__(self) -> None:
        per_call = _positive_decimal("asset_per_call", self.asset_per_call)
        daily = _positive_decimal("asset_daily", self.asset_daily)
        lifetime = _positive_decimal("asset_lifetime", self.asset_lifetime)
        if per_call > daily or daily > lifetime:
            raise ValueError("asset caps must be ordered per-call <= daily <= lifetime")
        fee_per_call = _drops(
            "fee_per_call_drops", self.fee_per_call_drops, positive=True
        )
        fee_daily = _drops("fee_daily_drops", self.fee_daily_drops, positive=True)
        fee_lifetime = _drops(
            "fee_lifetime_drops", self.fee_lifetime_drops, positive=True
        )
        if fee_per_call > fee_daily or fee_daily > fee_lifetime:
            raise ValueError("fee caps must be ordered per-call <= daily <= lifetime")
        _drops("minimum_xrp_reserve_drops", self.minimum_xrp_reserve_drops)


@dataclass(frozen=True)
class BudgetReservation:
    idempotency_key: str
    invoice_id: str
    payer: str
    asset: IssuedAssetIdentity
    amount: str
    fee_drops: str
    state: Literal["reserved", "uncertain", "committed"]
    replay: bool = False


class IssuedAssetBudgetLedger:
    """Local atomic budget accounting for native-XRPL issued payments.

    Construction is inert by default. Callers must pass ``enabled=True`` to use
    the ledger. No currency conversion is performed: issued values use Decimal
    arithmetic, while XRP fees and reserve use integer drops.
    """

    def __init__(
        self,
        path: Path,
        limits: BudgetLimits,
        *,
        enabled: bool = False,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._path = path.absolute()
        self._limits = limits
        self._enabled = enabled
        self._clock = clock
        self._prepare_path()
        self._initialize()

    def _prepare_path(self) -> None:
        if self._path.exists() and self._path.is_symlink():
            raise ValueError("budget database must not be a symlink")
        parent = self._path.parent
        if parent.exists() and parent.is_symlink():
            raise ValueError("budget database directory must not be a symlink")
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if parent.is_symlink():
            raise ValueError("budget database directory must not be a symlink")
        try:
            os.chmod(parent, 0o700)
        except OSError:
            pass

    def _connect(self) -> sqlite3.Connection:
        if self._path.is_symlink():
            raise ValueError("budget database must not be a symlink")
        connection = sqlite3.connect(str(self._path), timeout=5.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS x402_issued_budget (
                    idempotency_key TEXT PRIMARY KEY,
                    invoice_id TEXT NOT NULL UNIQUE,
                    payer TEXT NOT NULL,
                    network TEXT NOT NULL,
                    currency TEXT NOT NULL,
                    issuer TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    fee_drops TEXT NOT NULL,
                    budget_day TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN
                        ('reserved', 'uncertain', 'committed', 'released')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
        os.chmod(self._path, 0o600)

    def _now(self) -> datetime:
        now = self._clock()
        if not isinstance(now, datetime) or now.tzinfo is None:
            raise ValueError("budget clock must return a timezone-aware datetime")
        return now.astimezone(timezone.utc)

    @staticmethod
    def _from_row(row: sqlite3.Row, *, replay: bool) -> BudgetReservation:
        state = row["state"]
        if state == "released":
            raise BudgetConflict("idempotency key was already released")
        return BudgetReservation(
            idempotency_key=row["idempotency_key"],
            invoice_id=row["invoice_id"],
            payer=row["payer"],
            asset=IssuedAssetIdentity(
                network=row["network"],
                currency=row["currency"],
                issuer=row["issuer"],
            ),
            amount=row["amount"],
            fee_drops=row["fee_drops"],
            state=state,
            replay=replay,
        )

    @staticmethod
    def _same_binding(
        row: sqlite3.Row,
        *,
        invoice_id: str,
        payer: str,
        asset: IssuedAssetIdentity,
        amount: str,
        fee_drops: str,
    ) -> bool:
        return (
            row["invoice_id"] == invoice_id
            and row["payer"] == payer
            and row["network"] == asset.network
            and row["currency"] == asset.currency
            and row["issuer"] == asset.issuer
            and row["amount"] == amount
            and row["fee_drops"] == fee_drops
        )

    @staticmethod
    def _sum_decimal(rows: list[sqlite3.Row]) -> Decimal:
        return sum((Decimal(row["amount"]) for row in rows), Decimal(0))

    @staticmethod
    def _sum_drops(rows: list[sqlite3.Row]) -> int:
        return sum(int(row["fee_drops"]) for row in rows)

    def reserve(
        self,
        *,
        idempotency_key: str,
        invoice_id: str,
        payer: str,
        asset: IssuedAssetIdentity,
        amount: str,
        fee_drops: str,
        payer_xrp_balance_drops: str,
    ) -> BudgetReservation:
        if not self._enabled:
            raise BudgetDisabled("issued-asset budget ledger is disabled")
        idempotency_key = _identity_part("idempotency key", idempotency_key)
        invoice_id = _identity_part("invoice id", invoice_id)
        payer = _identity_part("payer", payer)
        if not is_valid_classic_address(payer):
            raise ValueError("payer must be a valid XRPL classic address")
        amount_value = _positive_decimal("amount", amount)
        fee_value = _drops("fee_drops", fee_drops, positive=True)
        balance_value = _drops("payer_xrp_balance_drops", payer_xrp_balance_drops)
        reserve_value = _drops(
            "minimum_xrp_reserve_drops", self._limits.minimum_xrp_reserve_drops
        )
        if amount_value > Decimal(self._limits.asset_per_call):
            raise BudgetExceeded("asset_per_call_exceeded")
        if fee_value > int(self._limits.fee_per_call_drops):
            raise BudgetExceeded("fee_per_call_exceeded")
        now = self._now()
        budget_day = now.date().isoformat()
        timestamp = now.isoformat()
        counted_placeholders = ",".join("?" for _ in COUNTED_STATES)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM x402_issued_budget WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if existing is not None:
                connection.execute("COMMIT")
                if not self._same_binding(
                    existing,
                    invoice_id=invoice_id,
                    payer=payer,
                    asset=asset,
                    amount=amount,
                    fee_drops=fee_drops,
                ):
                    raise BudgetConflict("idempotency key binding conflict")
                return self._from_row(existing, replay=True)

            invoice_binding = connection.execute(
                "SELECT idempotency_key FROM x402_issued_budget WHERE invoice_id = ?",
                (invoice_id,),
            ).fetchone()
            if invoice_binding is not None:
                connection.execute("COMMIT")
                raise BudgetConflict("invoice id binding conflict")

            asset_rows = connection.execute(
                f"""
                SELECT amount FROM x402_issued_budget
                WHERE payer = ? AND network = ? AND currency = ? AND issuer = ?
                  AND state IN ({counted_placeholders})
                """,
                (payer, asset.network, asset.currency, asset.issuer, *COUNTED_STATES),
            ).fetchall()
            daily_asset_rows = connection.execute(
                f"""
                SELECT amount FROM x402_issued_budget
                WHERE payer = ? AND network = ? AND currency = ? AND issuer = ?
                  AND budget_day = ? AND state IN ({counted_placeholders})
                """,
                (
                    payer,
                    asset.network,
                    asset.currency,
                    asset.issuer,
                    budget_day,
                    *COUNTED_STATES,
                ),
            ).fetchall()
            fee_rows = connection.execute(
                f"""
                SELECT fee_drops FROM x402_issued_budget
                WHERE payer = ? AND state IN ({counted_placeholders})
                """,
                (payer, *COUNTED_STATES),
            ).fetchall()
            daily_fee_rows = connection.execute(
                f"""
                SELECT fee_drops FROM x402_issued_budget
                WHERE payer = ? AND budget_day = ?
                  AND state IN ({counted_placeholders})
                """,
                (payer, budget_day, *COUNTED_STATES),
            ).fetchall()
            active_fee_rows = connection.execute(
                """
                SELECT fee_drops FROM x402_issued_budget
                WHERE payer = ? AND state IN ('reserved', 'uncertain')
                """,
                (payer,),
            ).fetchall()

            if (
                balance_value - self._sum_drops(active_fee_rows) - fee_value
                < reserve_value
            ):
                connection.execute("ROLLBACK")
                raise InsufficientXrpReserve("minimum_xrp_reserve_not_preserved")

            if self._sum_decimal(daily_asset_rows) + amount_value > Decimal(
                self._limits.asset_daily
            ):
                connection.execute("ROLLBACK")
                raise BudgetExceeded("asset_daily_exceeded")
            if self._sum_decimal(asset_rows) + amount_value > Decimal(
                self._limits.asset_lifetime
            ):
                connection.execute("ROLLBACK")
                raise BudgetExceeded("asset_lifetime_exceeded")
            if self._sum_drops(daily_fee_rows) + fee_value > int(
                self._limits.fee_daily_drops
            ):
                connection.execute("ROLLBACK")
                raise BudgetExceeded("fee_daily_exceeded")
            if self._sum_drops(fee_rows) + fee_value > int(
                self._limits.fee_lifetime_drops
            ):
                connection.execute("ROLLBACK")
                raise BudgetExceeded("fee_lifetime_exceeded")

            connection.execute(
                """
                INSERT INTO x402_issued_budget (
                    idempotency_key, invoice_id, payer, network, currency,
                    issuer, amount, fee_drops, budget_day, state,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
                """,
                (
                    idempotency_key,
                    invoice_id,
                    payer,
                    asset.network,
                    asset.currency,
                    asset.issuer,
                    amount,
                    fee_drops,
                    budget_day,
                    timestamp,
                    timestamp,
                ),
            )
            row = connection.execute(
                "SELECT * FROM x402_issued_budget WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            connection.execute("COMMIT")
        assert row is not None
        return self._from_row(row, replay=False)

    def _transition(
        self,
        idempotency_key: str,
        *,
        target: Literal["uncertain", "committed", "released"],
    ) -> bool:
        if not self._enabled:
            raise BudgetDisabled("issued-asset budget ledger is disabled")
        now = self._now().isoformat()
        allowed = {
            "uncertain": ("reserved", "uncertain"),
            "committed": ("reserved", "uncertain", "committed"),
            "released": ("reserved", "released"),
        }[target]
        placeholders = ",".join("?" for _ in allowed)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT state FROM x402_issued_budget WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if row is None or row["state"] not in allowed:
                connection.execute("COMMIT")
                return False
            if row["state"] == target:
                connection.execute("COMMIT")
                return True
            cursor = connection.execute(
                f"""
                UPDATE x402_issued_budget SET state = ?, updated_at = ?
                WHERE idempotency_key = ? AND state IN ({placeholders})
                """,
                (target, now, idempotency_key, *allowed),
            )
            connection.execute("COMMIT")
        return cursor.rowcount == 1

    def mark_uncertain(self, idempotency_key: str) -> bool:
        return self._transition(idempotency_key, target="uncertain")

    def commit(self, idempotency_key: str) -> bool:
        return self._transition(idempotency_key, target="committed")

    def release(self, idempotency_key: str) -> bool:
        return self._transition(idempotency_key, target="released")

    def release_not_included(self, idempotency_key: str) -> bool:
        """Release only after conclusive ledger-window absence proof.

        Ordinary ``release`` deliberately cannot free an uncertain reservation.
        Reconciliation may use this narrower transition once the transaction's
        LastLedgerSequence has passed and the complete search window proves the
        transaction was not included.
        """

        if not self._enabled:
            raise BudgetDisabled("issued-asset budget ledger is disabled")
        now = self._now().isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT state FROM x402_issued_budget WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if row is None or row["state"] not in {
                "reserved", "uncertain", "released"
            }:
                connection.execute("COMMIT")
                return False
            if row["state"] == "released":
                connection.execute("COMMIT")
                return True
            cursor = connection.execute(
                """
                UPDATE x402_issued_budget SET state = 'released', updated_at = ?
                WHERE idempotency_key = ? AND state IN ('reserved', 'uncertain')
                """,
                (now, idempotency_key),
            )
            connection.execute("COMMIT")
        return cursor.rowcount == 1
