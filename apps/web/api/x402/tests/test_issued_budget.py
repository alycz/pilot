from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pytest

from apps.web.api.x402.budget import (
    BudgetConflict,
    BudgetDisabled,
    BudgetExceeded,
    BudgetLimits,
    InsufficientXrpReserve,
    IssuedAssetBudgetLedger,
    IssuedAssetIdentity,
)


RLUSD = IssuedAssetIdentity(
    network="xrpl:1",
    currency="524C555344000000000000000000000000000000",
    issuer="rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
)
OTHER_ISSUER = IssuedAssetIdentity(
    network="xrpl:1",
    currency=RLUSD.currency,
    issuer="rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr",
)
PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn"


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def limits() -> BudgetLimits:
    return BudgetLimits(
        asset_per_call="5",
        asset_daily="8.5",
        asset_lifetime="10",
        fee_per_call_drops="12",
        fee_daily_drops="20",
        fee_lifetime_drops="30",
        minimum_xrp_reserve_drops="100",
    )


def ledger(tmp_path: Path, limits: BudgetLimits, clock: Clock) -> IssuedAssetBudgetLedger:
    return IssuedAssetBudgetLedger(
        tmp_path / "issued-budget.sqlite3",
        limits,
        enabled=True,
        clock=clock,
    )


def reserve(
    budget: IssuedAssetBudgetLedger,
    key: str,
    *,
    invoice: Optional[str] = None,
    asset: IssuedAssetIdentity = RLUSD,
    amount: str = "2.5",
    fee: str = "5",
    balance: str = "1000",
):
    return budget.reserve(
        idempotency_key=key,
        invoice_id=invoice or f"invoice-{key}",
        payer=PAYER,
        asset=asset,
        amount=amount,
        fee_drops=fee,
        payer_xrp_balance_drops=balance,
    )


def test_budget_is_default_off(tmp_path: Path, limits: BudgetLimits, clock: Clock) -> None:
    budget = IssuedAssetBudgetLedger(tmp_path / "off.sqlite3", limits, clock=clock)
    with pytest.raises(BudgetDisabled):
        reserve(budget, "disabled")


@pytest.mark.parametrize(
    "amount",
    ("1.0", "01", "+1", "-1", "1e1", "NaN", "Infinity", "0", 1.0),
)
def test_amounts_are_canonical_decimal_strings_only(
    tmp_path: Path,
    limits: BudgetLimits,
    clock: Clock,
    amount: object,
) -> None:
    budget = ledger(tmp_path, limits, clock)
    with pytest.raises(ValueError):
        reserve(budget, "decimal", amount=amount)  # type: ignore[arg-type]


def test_same_binding_replays_and_mismatch_conflicts(
    tmp_path: Path, limits: BudgetLimits, clock: Clock
) -> None:
    budget = ledger(tmp_path, limits, clock)
    first = reserve(budget, "same", invoice="invoice-same")
    replay = reserve(budget, "same", invoice="invoice-same")
    assert first.replay is False
    assert replay.replay is True
    assert replay == type(replay)(**{**first.__dict__, "replay": True})

    with pytest.raises(BudgetConflict):
        reserve(budget, "same", invoice="different-invoice")
    with pytest.raises(BudgetConflict):
        reserve(budget, "different-key", invoice="invoice-same")
    with pytest.raises(BudgetConflict):
        reserve(budget, "same", invoice="invoice-same", asset=OTHER_ISSUER)
    with pytest.raises(BudgetConflict):
        reserve(budget, "same", invoice="invoice-same", amount="2.6")


def test_asset_caps_are_exact_and_keyed_by_full_identity(
    tmp_path: Path, limits: BudgetLimits, clock: Clock
) -> None:
    budget = ledger(tmp_path, limits, clock)
    reserve(budget, "a", amount="4.25")
    reserve(budget, "b", amount="4.25")
    with pytest.raises(BudgetExceeded, match="asset_daily_exceeded"):
        reserve(budget, "c", amount="0.01")

    # A different issuer is a different asset budget; no ticker-only sharing.
    reserve(budget, "other", asset=OTHER_ISSUER, amount="5")
    clock.value += timedelta(days=1)
    reserve(budget, "next-day", amount="1.5")
    with pytest.raises(BudgetExceeded, match="asset_lifetime_exceeded"):
        reserve(budget, "lifetime", amount="0.01")


def test_fee_caps_are_separate_xrp_drops_and_cross_asset(
    tmp_path: Path, limits: BudgetLimits, clock: Clock
) -> None:
    budget = ledger(tmp_path, limits, clock)
    with pytest.raises(BudgetExceeded, match="fee_per_call_exceeded"):
        reserve(budget, "per-call-fee", amount="0.01", fee="13")
    reserve(budget, "fee-a", amount="0.01", fee="12")
    reserve(budget, "fee-b", asset=OTHER_ISSUER, amount="0.01", fee="8")
    with pytest.raises(BudgetExceeded, match="fee_daily_exceeded"):
        reserve(budget, "fee-daily", amount="0.01", fee="1")
    clock.value += timedelta(days=1)
    reserve(budget, "fee-next", amount="0.01", fee="10")
    with pytest.raises(BudgetExceeded, match="fee_lifetime_exceeded"):
        reserve(budget, "fee-life", amount="0.01", fee="1")


def test_minimum_xrp_reserve_is_not_derived_from_asset_value(
    tmp_path: Path, limits: BudgetLimits, clock: Clock
) -> None:
    budget = ledger(tmp_path, limits, clock)
    reserve(budget, "reserve-exact", amount="0.01", fee="5", balance="105")
    with pytest.raises(InsufficientXrpReserve):
        reserve(budget, "reserve-short", amount="0.01", fee="5", balance="104")


def test_active_fee_reservations_share_one_xrp_reserve_floor(
    tmp_path: Path, limits: BudgetLimits, clock: Clock
) -> None:
    budget = ledger(tmp_path, limits, clock)
    reserve(budget, "fee-one", amount="0.01", fee="6", balance="111")
    with pytest.raises(InsufficientXrpReserve):
        reserve(budget, "fee-two", amount="0.01", fee="6", balance="111")


def test_release_frees_budget_but_uncertain_remains_reserved(
    tmp_path: Path, limits: BudgetLimits, clock: Clock
) -> None:
    budget = ledger(tmp_path, limits, clock)
    reserve(budget, "released", amount="5")
    assert budget.release("released") is True
    assert budget.release("released") is True
    reserve(budget, "replacement", amount="5")

    reserve(budget, "uncertain", amount="3.5")
    assert budget.mark_uncertain("uncertain") is True
    assert budget.release("uncertain") is False
    with pytest.raises(BudgetExceeded, match="asset_daily_exceeded"):
        reserve(budget, "would-double-spend", amount="0.01")
    assert budget.commit("uncertain") is True
    assert budget.commit("uncertain") is True


def test_concurrent_reservations_cannot_oversubscribe(
    tmp_path: Path, limits: BudgetLimits, clock: Clock
) -> None:
    tight = BudgetLimits(
        asset_per_call="5",
        asset_daily="5",
        asset_lifetime="5",
        fee_per_call_drops="10",
        fee_daily_drops="10",
        fee_lifetime_drops="10",
        minimum_xrp_reserve_drops="100",
    )
    budget = ledger(tmp_path, tight, clock)
    barrier = threading.Barrier(3)
    outcomes: list[str] = []
    lock = threading.Lock()

    def worker(key: str) -> None:
        barrier.wait()
        try:
            reserve(budget, key, amount="5", fee="10")
            outcome = "reserved"
        except (BudgetExceeded, BudgetConflict):
            outcome = "rejected"
        with lock:
            outcomes.append(outcome)

    threads = [threading.Thread(target=worker, args=(key,)) for key in ("one", "two")]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=5)

    assert sorted(outcomes) == ["rejected", "reserved"]
