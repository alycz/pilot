from __future__ import annotations

"""JSON-lines harness for the offline Harbor-to-Python contract test.

The parent supplies public classic addresses and a signed fixture blob. This
process never receives a seed, private key, credential, or network endpoint.
"""

import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from xrpl.core.addresscodec import decode_classic_address

from apps.web.api.x402.assets import IssuedCurrencyAsset, asset_identity_key
from apps.web.api.x402.budget import BudgetLimits, IssuedAssetBudgetLedger
from apps.web.api.x402.config import MerchantConfig, RESOURCE_PATH
from apps.web.api.x402.issued_compare import create_offline_issued_app
from apps.web.api.x402.issued_ledger import LedgerSnapshot


CURRENCY = "524C555344000000000000000000000000000000"


def _emit(value: Any) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _request() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("cross-process request stream ended")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("cross-process request must be an object")
    return value


def _snapshot(payer: str, pay_to: str, issuer: str) -> LedgerSnapshot:
    fixture_path = Path(__file__).parent / "fixtures" / "xrpl_issued_rlusd_validated.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
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
    return LedgerSnapshot.from_mapping(fixture)


def main() -> int:
    init = _request()
    if set(init) != {"payer", "payTo", "issuer"}:
        raise ValueError("cross-process init fields are not exact")
    payer, pay_to, issuer = init["payer"], init["payTo"], init["issuer"]
    if not all(isinstance(value, str) for value in (payer, pay_to, issuer)):
        raise ValueError("cross-process addresses must be strings")
    with tempfile.TemporaryDirectory(prefix="pilot-x402-issued-") as directory:
        root = Path(directory)
        asset = IssuedCurrencyAsset(CURRENCY, issuer)
        config = MerchantConfig(
            pay_to=pay_to,
            price_drops="5000",
            source_tag=2_610_240,
            max_timeout_seconds=60,
            max_payer_fee_drops="20",
            invoice_db_path=root / "invoices.sqlite3",
        )
        budget = IssuedAssetBudgetLedger(
            root / "budget.sqlite3",
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
        app = create_offline_issued_app(
            config=config,
            asset=asset,
            amount="0.01",
            asset_allowlist={asset_identity_key(asset)},
            snapshot=_snapshot(payer, pay_to, issuer),
            budget=budget,
            ledger_state_path=root / "ledger.sqlite3",
            clock=lambda: datetime(
                2026, 10, 24, 12, tzinfo=timezone.utc
            ).timestamp(),
            invoice_id_factory=lambda: "cross-process-invoice-0001",
        )
        with TestClient(
            app,
            base_url="http://127.0.0.1:8000",
            client=("127.0.0.1", 50_000),
        ) as client:
            challenge = client.get(RESOURCE_PATH)
            _emit(
                {
                    "status": challenge.status_code,
                    "body": challenge.json(),
                    "paymentRequired": challenge.headers.get("payment-required"),
                }
            )
            for line in sys.stdin:
                request = json.loads(line)
                if not isinstance(request, dict) or set(request) != {"paymentSignature"}:
                    raise ValueError("cross-process payment fields are not exact")
                signature = request["paymentSignature"]
                if not isinstance(signature, str):
                    raise ValueError("cross-process payment signature must be a string")
                response = client.post(
                    RESOURCE_PATH, headers={"PAYMENT-SIGNATURE": signature}
                )
                _emit(
                    {
                        "status": response.status_code,
                        "body": response.json(),
                        "paymentResponse": response.headers.get("payment-response"),
                    }
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
