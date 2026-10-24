"""Offline-only coverage for the MM3 settlement console endpoint."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from paychan import PaychanFailure, SettlementResult, build_disabled_runtime


MERCHANT_ID = "venue-yield-desk"
CHANNEL_ID = "ab" * 32
CHANNEL_ID_CANONICAL = CHANNEL_ID.upper()
TX_HASH = "CD" * 32


class ScriptedRuntime:
    def __init__(self, *outcomes: SettlementResult | PaychanFailure) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, str | None]] = []

    async def settle(
        self,
        merchant_id: str,
        channel_id: str | None = None,
    ) -> SettlementResult:
        self.calls.append((merchant_id, channel_id))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, PaychanFailure):
            raise outcome
        return outcome


@pytest.fixture(autouse=True)
def restore_runtime() -> Iterator[None]:
    previous = app.state.mm3_runtime
    try:
        yield
    finally:
        app.state.mm3_runtime = previous


def failure(code: str, http_status: int) -> PaychanFailure:
    return PaychanFailure(code, "attacker-controlled detail must not escape", http_status)


def result(*, replayed: bool) -> SettlementResult:
    return SettlementResult(
        channel_id=CHANNEL_ID_CANONICAL,
        cumulative_drops="9000",
        tx_hash=TX_HASH,
        replayed=replayed,
    )


def test_settle_rejects_unknown_merchant_without_calling_runtime() -> None:
    runtime = ScriptedRuntime(result(replayed=False))
    app.state.mm3_runtime = runtime

    response = TestClient(app).post("/m/not-a-merchant/settle")

    assert response.status_code == 404
    assert response.json() == {"detail": "unknown merchant: not-a-merchant"}
    assert runtime.calls == []


def test_settle_reports_no_pending_claim_with_fixed_error() -> None:
    runtime = ScriptedRuntime(failure("PAYCHAN_NO_PENDING", 409))
    app.state.mm3_runtime = runtime

    response = TestClient(app).post(f"/m/{MERCHANT_ID}/settle")

    assert response.status_code == 409
    assert response.json() == {
        "error": "PAYCHAN_NO_PENDING",
        "message": "no pending payment-channel claim",
    }
    assert "attacker-controlled" not in response.text
    assert runtime.calls == [(MERCHANT_ID, None)]


def test_settle_reports_durable_uncertainty_without_internal_detail() -> None:
    runtime = ScriptedRuntime(failure("PAYCHAN_SETTLEMENT_UNCERTAIN", 409))
    app.state.mm3_runtime = runtime

    response = TestClient(app).post(
        f"/m/{MERCHANT_ID}/settle",
        json={"channel_id": CHANNEL_ID},
    )

    assert response.status_code == 409
    assert response.json() == {
        "error": "PAYCHAN_SETTLEMENT_UNCERTAIN",
        "message": "payment-channel settlement outcome is uncertain",
    }
    assert "attacker-controlled" not in response.text
    assert runtime.calls == [(MERCHANT_ID, CHANNEL_ID_CANONICAL)]


def test_settle_reports_pending_redemption_event_without_internal_detail() -> None:
    runtime = ScriptedRuntime(failure("PAYCHAN_EVENT_PENDING", 503))
    app.state.mm3_runtime = runtime

    response = TestClient(app).post(f"/m/{MERCHANT_ID}/settle")

    assert response.status_code == 503
    assert response.json() == {
        "error": "PAYCHAN_EVENT_PENDING",
        "message": "payment-channel redemption event is pending",
    }
    assert "attacker-controlled" not in response.text
    assert runtime.calls == [(MERCHANT_ID, None)]


def test_settle_hides_submitter_failure_detail() -> None:
    runtime = ScriptedRuntime(failure("PAYCHAN_SUBMIT_FAILED", 502))
    app.state.mm3_runtime = runtime

    response = TestClient(app).post(
        f"/m/{MERCHANT_ID}/settle",
        json={"channel_id": CHANNEL_ID},
    )

    assert response.status_code == 502
    assert response.json() == {
        "error": "PAYCHAN_SUBMIT_FAILED",
        "message": "payment-channel settlement failed",
    }
    assert "attacker-controlled" not in response.text
    assert runtime.calls == [(MERCHANT_ID, CHANNEL_ID_CANONICAL)]


@pytest.mark.parametrize(
    ("code", "failure_status", "status", "message"),
    [
        (
            "PAYCHAN_CHANNEL_REQUIRED",
            409,
            409,
            "channel id is required",
        ),
        (
            "PAYCHAN_NOT_REDEEMED",
            402,
            402,
            "payment-channel redemption was not validated",
        ),
        (
            "PAYCHAN_REDEEM_RACE",
            409,
            409,
            "a newer payment-channel claim must be settled",
        ),
    ],
)
def test_settle_maps_known_failures_without_leaking_detail(
    code: str,
    failure_status: int,
    status: int,
    message: str,
) -> None:
    runtime = ScriptedRuntime(failure(code, failure_status))
    app.state.mm3_runtime = runtime

    response = TestClient(app).post(f"/m/{MERCHANT_ID}/settle")

    assert response.status_code == status
    assert response.json() == {"error": code, "message": message}
    assert "attacker-controlled" not in response.text


def test_settle_default_runtime_is_fail_closed_without_transport() -> None:
    app.state.mm3_runtime = build_disabled_runtime()

    response = TestClient(app).post(f"/m/{MERCHANT_ID}/settle")

    assert response.status_code == 503
    assert response.json() == {
        "error": "PAYCHAN_SETTLEMENT_DISABLED",
        "message": "payment-channel settlement is unavailable",
    }


def test_settle_maps_unknown_runtime_failure_to_generic_server_error() -> None:
    runtime = ScriptedRuntime(failure("ATTACKER_CONTROLLED_CODE", 418))
    app.state.mm3_runtime = runtime

    response = TestClient(app).post(f"/m/{MERCHANT_ID}/settle")

    assert response.status_code == 500
    assert response.json() == {
        "error": "PAYCHAN_SETTLEMENT_FAILED",
        "message": "payment-channel settlement failed",
    }
    assert "ATTACKER_CONTROLLED_CODE" not in response.text
    assert "attacker-controlled" not in response.text


def test_settle_rejects_malformed_or_extra_channel_selection() -> None:
    runtime = ScriptedRuntime(result(replayed=False))
    app.state.mm3_runtime = runtime
    client = TestClient(app)

    malformed = client.post(
        f"/m/{MERCHANT_ID}/settle",
        json={"channel_id": "attacker-controlled"},
    )
    extra = client.post(
        f"/m/{MERCHANT_ID}/settle",
        json={"channel_id": CHANNEL_ID, "unexpected": "attacker-controlled"},
    )

    assert malformed.status_code == extra.status_code == 422
    assert "attacker-controlled" not in malformed.text
    assert "attacker-controlled" not in extra.text
    assert runtime.calls == []


def test_settle_is_replay_safe_and_returns_runtime_result() -> None:
    runtime = ScriptedRuntime(result(replayed=False), result(replayed=True))
    app.state.mm3_runtime = runtime
    client = TestClient(app)

    first = client.post(
        f"/m/{MERCHANT_ID}/settle",
        json={"channel_id": CHANNEL_ID},
    )
    replay = client.post(
        f"/m/{MERCHANT_ID}/settle",
        json={"channel_id": CHANNEL_ID},
    )

    assert first.status_code == replay.status_code == 200
    assert first.json() == {
        "channel_id": CHANNEL_ID_CANONICAL,
        "cumulative_drops": "9000",
        "tx_hash": TX_HASH,
        "replayed": False,
    }
    assert replay.json() == {**first.json(), "replayed": True}
    assert runtime.calls == [
        (MERCHANT_ID, CHANNEL_ID_CANONICAL),
        (MERCHANT_ID, CHANNEL_ID_CANONICAL),
    ]
