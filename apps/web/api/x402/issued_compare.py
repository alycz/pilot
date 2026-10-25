from __future__ import annotations

"""Default-off local merchant for native XRPL issued-currency x402 tests."""

import time
import uuid
from pathlib import Path
from typing import Callable, Collection

from fastapi import FastAPI

from .assets import (
    IssuedCurrencyAsset,
    PaymentOffer,
    asset_identity_key,
    require_asset_allowed,
)
from .budget import IssuedAssetBudgetLedger
from .compare import create_app
from .config import MerchantConfig, RESOURCE_URL
from .issued_ledger import LedgerSnapshot, OfflineIssuedCurrencyFacilitator


ISSUED_RESOURCE_INFO = {
    "url": RESOURCE_URL,
    "description": "Local Pilot venue comparison paid with native XRPL issued currency",
    "mimeType": "application/json",
    "serviceName": "Pilot",
    "tags": ["compare", "native-xrpl-issued-currency", "offline-fixture"],
}
ISSUED_FIXTURE_BODY = {
    "comparison": ["dex", "amm"],
    "paymentEvidence": "deterministic-offline-fixture-not-live-validation",
}
ISSUED_MERCHANT_ID = "pilot-x402-issued-merchant-v1"


def create_offline_issued_app(
    *,
    config: MerchantConfig,
    asset: IssuedCurrencyAsset,
    amount: str,
    asset_allowlist: Collection[str],
    snapshot: LedgerSnapshot,
    budget: IssuedAssetBudgetLedger,
    ledger_state_path: Path,
    clock: Callable[[], float] = time.time,
    invoice_id_factory: Callable[[], str] = lambda: (
        f"pilot-issued-{uuid.uuid4().hex}"
    ),
) -> FastAPI:
    """Build the explicit local fixture lane.

    Nothing is selected from environment variables. The caller must provide
    the exact asset allowlist, snapshot and enabled budget ledger. This adapter
    never contacts XRPL or a facilitator and cannot be used as live evidence.
    """

    require_asset_allowed(asset, asset_allowlist)
    if asset_identity_key(asset) not in asset_allowlist:
        raise ValueError("issued asset allowlist binding failed")
    return create_app(
        config,
        OfflineIssuedCurrencyFacilitator(snapshot, ledger_state_path),
        clock=clock,
        invoice_id_factory=invoice_id_factory,
        offer=PaymentOffer(asset, amount),
        budget=budget,
        allow_fixture_evidence=True,
        merchant_id=ISSUED_MERCHANT_ID,
        resource_info=ISSUED_RESOURCE_INFO,
        merchant_body=ISSUED_FIXTURE_BODY,
    )
