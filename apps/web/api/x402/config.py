from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from xrpl.core.addresscodec import is_valid_classic_address


RESOURCE_PATH = "/api/x402/compare"
RESOURCE_URL = "http://127.0.0.1:8000/api/x402/compare"
T54_TESTNET_FACILITATOR_URL = "https://xrpl-facilitator-testnet.t54.ai"
XRPL_TESTNET_JSON_RPC_URL = "https://s.altnet.rippletest.net:51234/"
DEFAULT_PAY_TO = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr"
DEFAULT_SOURCE_TAG = 2_610_240
ISOLATED_PRICE_DROPS = "5000"
CANONICAL_POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
UINT32_MAX = 0xFFFF_FFFF
LOCAL_INVOICE_DB_PATH = (
    Path(__file__).resolve().parent / ".local" / "invoices.sqlite3"
)


def _positive_drops(name: str, value: str, ceiling: int) -> str:
    if not CANONICAL_POSITIVE_INTEGER.fullmatch(value):
        raise ValueError(f"{name} must be a canonical positive drops string")
    if int(value) > ceiling:
        raise ValueError(f"{name} must be at most {ceiling} drops")
    return value


def _uint32(name: str, value: str) -> int:
    if not re.fullmatch(r"0|[1-9][0-9]*", value):
        raise ValueError(f"{name} must be a canonical uint32")
    parsed = int(value)
    if parsed > UINT32_MAX:
        raise ValueError(f"{name} must be a canonical uint32")
    return parsed


@dataclass(frozen=True)
class MerchantConfig:
    pay_to: str
    price_drops: str
    source_tag: int
    max_timeout_seconds: int
    max_payer_fee_drops: str
    invoice_db_path: Path
    facilitator_url: str = T54_TESTNET_FACILITATOR_URL
    xrpl_json_rpc_url: str = XRPL_TESTNET_JSON_RPC_URL

    def __post_init__(self) -> None:
        if not is_valid_classic_address(self.pay_to):
            raise ValueError("XRPL_X402_PAY_TO must be a valid XRPL classic address")
        _positive_drops("XRPL_X402_PRICE_DROPS", self.price_drops, 100_000)
        _positive_drops(
            "XRPL_X402_MAX_PAYER_FEE_DROPS",
            self.max_payer_fee_drops,
            100,
        )
        if not 0 <= self.source_tag <= UINT32_MAX:
            raise ValueError("XRPL_X402_SOURCE_TAG must be a uint32")
        if not 1 <= self.max_timeout_seconds <= 600:
            raise ValueError("XRPL_X402_TIMEOUT_SECONDS must be between 1 and 600")
        if self.facilitator_url != T54_TESTNET_FACILITATOR_URL:
            raise ValueError("only the fixed T54 XRPL Testnet facilitator is permitted")
        if self.xrpl_json_rpc_url != XRPL_TESTNET_JSON_RPC_URL:
            raise ValueError(
                "only the fixed official XRPL Testnet JSON-RPC endpoint is permitted"
            )

    @classmethod
    def from_env(cls) -> "MerchantConfig":
        timeout_text = os.getenv("XRPL_X402_TIMEOUT_SECONDS", "60")
        if not re.fullmatch(r"[1-9][0-9]*", timeout_text):
            raise ValueError("XRPL_X402_TIMEOUT_SECONDS must be a positive integer")
        source_tag = _uint32(
            "XRPL_X402_SOURCE_TAG",
            os.getenv("XRPL_X402_SOURCE_TAG", str(DEFAULT_SOURCE_TAG)),
        )
        if "XRPL_X402_INVOICE_DB" in os.environ:
            raise ValueError(
                "XRPL_X402_INVOICE_DB is not configurable; merchant storage is local"
            )
        return cls(
            pay_to=os.getenv("XRPL_X402_PAY_TO", DEFAULT_PAY_TO),
            price_drops=_positive_drops(
                "XRPL_X402_PRICE_DROPS",
                os.getenv("XRPL_X402_PRICE_DROPS", "5000"),
                100_000,
            ),
            source_tag=source_tag,
            max_timeout_seconds=int(timeout_text),
            max_payer_fee_drops=_positive_drops(
                "XRPL_X402_MAX_PAYER_FEE_DROPS",
                os.getenv("XRPL_X402_MAX_PAYER_FEE_DROPS", "100"),
                100,
            ),
            invoice_db_path=LOCAL_INVOICE_DB_PATH,
            facilitator_url=os.getenv(
                "XRPL_X402_FACILITATOR_URL", T54_TESTNET_FACILITATOR_URL
            ).rstrip("/"),
            xrpl_json_rpc_url=XRPL_TESTNET_JSON_RPC_URL,
        )


def require_isolated_merchant_config(config: MerchantConfig) -> MerchantConfig:
    """Fail closed unless config matches the reviewed isolated payment contract."""

    if config.price_drops != ISOLATED_PRICE_DROPS:
        raise ValueError(
            "isolated x402 price must be exactly "
            f"{ISOLATED_PRICE_DROPS} drops"
        )
    if config.pay_to != DEFAULT_PAY_TO:
        raise ValueError("isolated x402 receiver must be the reviewed default")
    # MerchantConfig already enforces a canonical positive fee ceiling of 100
    # drops. Keep that upper bound (rather than requiring exactly 100) because a
    # stricter configured payer fee remains compatible with the reviewed lane.
    return config
