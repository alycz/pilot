"""Deterministic public catalog for the two demo merchants."""

from dataclasses import dataclass
from typing import Any, Literal


MOCK_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"
MOCK_CREDENTIAL_ISSUER = "rDemoNetworkIssuer111111111111111111"
CREDENTIAL_TYPE_HEX = "4150344D2D4167656E74"


@dataclass(frozen=True)
class Merchant:
    id: str
    name: str
    src_dpa_id: str
    xrpl_address: str
    source_tag: int
    destination_tag: int | None
    schemes: tuple[Literal["exact", "xrpl-paychan"], ...]
    products: tuple[dict[str, Any], ...]


MERCHANTS: dict[str, Merchant] = {
    "venue-yield-desk": Merchant(
        id="venue-yield-desk",
        name="Venue Yield Desk",
        src_dpa_id="demo-dpa-venue-yield-desk",
        xrpl_address="rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        source_tag=2_610_240,
        destination_tag=None,
        schemes=("exact", "xrpl-paychan"),
        products=(
            {
                "sku": "yield-report",
                "name": "Venue yield report",
                "description": "Typed venue yield report",
                "price": {
                    "asset": {
                        "kind": "iou",
                        "currency": "RLUSD",
                        "issuer": MOCK_RLUSD_ISSUER,
                    },
                    "value": "1",
                },
                # Mock demo authority: 1 RLUSD is fixed to USD 1.00 here only.
                "price_usd_cents": 100,
                "response_schema_id": "yield_report_v1",
                "schemes": ["exact", "xrpl-paychan"],
            },
        ),
    ),
    "risk-oracle": Merchant(
        id="risk-oracle",
        name="Risk Oracle",
        src_dpa_id="demo-dpa-risk-oracle",
        xrpl_address="rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
        source_tag=2_610_241,
        destination_tag=None,
        schemes=("xrpl-paychan",),
        products=(
            {
                "sku": "risk-score",
                "name": "Venue risk score",
                "description": "Typed deterministic venue risk score and factors.",
                "price": {"asset": {"kind": "xrp"}, "value": "0.05"},
                # Mock pay-channel authority; not a live XRP/USD conversion.
                "price_usd_cents": 5,
                "response_schema_id": "risk_score_v1",
                "schemes": ["xrpl-paychan"],
            },
        ),
    ),
}


def merchant(merchant_id: str) -> Merchant:
    try:
        return MERCHANTS[merchant_id]
    except KeyError as exc:
        raise LookupError(f"unknown merchant: {merchant_id}") from exc


def product(merchant_id: str, sku: str) -> dict[str, Any]:
    for item in merchant(merchant_id).products:
        if item["sku"] == sku:
            return dict(item)
    raise LookupError(f"unknown product: {merchant_id}/{sku}")


def product_data(merchant_id: str, sku: str) -> dict[str, Any]:
    if (merchant_id, sku) == ("venue-yield-desk", "yield-report"):
        return {
            "schema_id": "yield_report_v1",
            "venue": "xrpl-amm",
            "apr_percent": "4.25",
            "tvl_usd": "2500000",
            "risk": "medium",
            "as_of_basis": "deterministic mock derived from Harbor venue catalog",
        }
    if (merchant_id, sku) == ("risk-oracle", "risk-score"):
        return {
            "schema_id": "risk_score_v1",
            "venue": "xrpl-amm",
            "score": 82,
            "rating": "low-risk",
            "factors": ["on-ledger liquidity", "issuer controls", "price depth"],
            "as_of_basis": "deterministic mock derived from Harbor venue catalog",
        }
    raise LookupError(f"unknown product: {merchant_id}/{sku}")
