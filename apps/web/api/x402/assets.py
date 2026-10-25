from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Collection, Literal, Mapping, Optional, Union

from xrpl.core.addresscodec import is_valid_classic_address


XRPL_TESTNET_NETWORK = "xrpl:1"
XRPL_ISSUED_CURRENCY = re.compile(r"^[0-9A-F]{40}$")
CANONICAL_DROPS = re.compile(r"^[1-9][0-9]*$")
CANONICAL_ISSUED_VALUE = re.compile(
    r"^(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?)$"
)
MAX_ISSUED_SIGNIFICANT_DIGITS = 15
MAX_ISSUED_VALUE_CHARACTERS = 128
MIN_ISSUED_NONZERO = Decimal("1e-81")
UINT32_MAX = 0xFFFF_FFFF


def _require_classic_address(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not is_valid_classic_address(value):
        raise ValueError(f"{field_name} must be a valid XRPL classic address")
    return value


def _require_testnet_network(value: Any) -> Literal["xrpl:1"]:
    if value != XRPL_TESTNET_NETWORK:
        raise ValueError("only the exact xrpl:1 network is supported")
    return XRPL_TESTNET_NETWORK


def _require_issued_currency(value: Any) -> str:
    if not isinstance(value, str) or not XRPL_ISSUED_CURRENCY.fullmatch(value):
        raise ValueError("issued currency must be exactly 40 uppercase hex characters")
    return value


def _require_positive_drops(value: Any) -> str:
    if not isinstance(value, str) or not CANONICAL_DROPS.fullmatch(value):
        raise ValueError("XRP amount must be a canonical positive drops string")
    return value


def _significant_digits(value: str) -> int:
    digits = value.replace(".", "").lstrip("0")
    return len(digits)


def canonical_issued_value(value: Any) -> str:
    """Return one exact XRPL issued-currency value without float coercion."""

    if (
        not isinstance(value, str)
        or len(value) > MAX_ISSUED_VALUE_CHARACTERS
        or not CANONICAL_ISSUED_VALUE.fullmatch(value)
        or _significant_digits(value) > MAX_ISSUED_SIGNIFICANT_DIGITS
    ):
        raise ValueError(
            "issued amount must be a canonical positive decimal string with at most "
            f"{MAX_ISSUED_SIGNIFICANT_DIGITS} significant digits"
        )
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:  # Defensive: the syntax check should reject first.
        raise ValueError("issued amount is not an exact decimal") from exc
    if not parsed.is_finite() or parsed < MIN_ISSUED_NONZERO:
        raise ValueError(
            "issued amount must be a canonical positive decimal string within "
            "the XRPL range"
        )
    return value


def exact_decimal_compare(left: str, right: str) -> int:
    """Compare canonical decimal strings using Decimal, never binary float."""

    left_decimal = Decimal(canonical_issued_value(left))
    right_decimal = Decimal(canonical_issued_value(right))
    return (left_decimal > right_decimal) - (left_decimal < right_decimal)


def exact_decimal_equal(left: str, right: str) -> bool:
    return exact_decimal_compare(left, right) == 0


@dataclass(frozen=True)
class NativeXrpAsset:
    network: str = XRPL_TESTNET_NETWORK
    kind: Literal["native-xrp"] = field(default="native-xrp", init=False)
    currency: Literal["XRP"] = field(default="XRP", init=False)

    def __post_init__(self) -> None:
        _require_testnet_network(self.network)


@dataclass(frozen=True)
class IssuedCurrencyAsset:
    currency: str
    issuer: str
    network: str = XRPL_TESTNET_NETWORK
    kind: Literal["issued-currency"] = field(
        default="issued-currency", init=False
    )

    def __post_init__(self) -> None:
        _require_testnet_network(self.network)
        _require_issued_currency(self.currency)
        _require_classic_address(self.issuer, "issuer")


PaymentAsset = Union[NativeXrpAsset, IssuedCurrencyAsset]


@dataclass(frozen=True)
class PaymentOffer:
    asset: PaymentAsset
    amount: str

    def __post_init__(self) -> None:
        if isinstance(self.asset, NativeXrpAsset):
            _require_positive_drops(self.amount)
        elif isinstance(self.asset, IssuedCurrencyAsset):
            canonical_issued_value(self.amount)
        else:
            raise TypeError("unsupported payment asset")


def asset_identity_key(asset: PaymentAsset) -> str:
    if isinstance(asset, NativeXrpAsset):
        return f"{asset.network}:native:XRP"
    if isinstance(asset, IssuedCurrencyAsset):
        return f"{asset.network}:issued:{asset.currency}:{asset.issuer}"
    raise TypeError("unsupported payment asset")


def is_asset_allowed(asset: PaymentAsset, allowlist: Collection[str]) -> bool:
    return asset_identity_key(asset) in allowlist


def require_asset_allowed(
    asset: PaymentAsset, allowlist: Collection[str]
) -> PaymentAsset:
    if not is_asset_allowed(asset, allowlist):
        raise ValueError("payment asset is not allowlisted")
    return asset


def validate_holder_to_holder(
    asset: PaymentAsset, payer: str, pay_to: str
) -> None:
    payer = _require_classic_address(payer, "payer")
    pay_to = _require_classic_address(pay_to, "pay_to")
    if payer == pay_to:
        raise ValueError("payer and payee must be distinct")
    if isinstance(asset, IssuedCurrencyAsset) and asset.issuer in {payer, pay_to}:
        raise ValueError("issued-currency issuer must be distinct from payer and payee")


def _require_source_tag(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= UINT32_MAX
    ):
        raise ValueError("sourceTag must be a uint32")
    return value


def _require_destination_tag(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= UINT32_MAX
    ):
        raise ValueError("destinationTag must be a uint32")
    return value


def _require_invoice_id(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value.encode("utf-8")) > 200
    ):
        raise ValueError("invoiceId must be non-empty and at most 200 UTF-8 bytes")
    return value


def _require_timeout(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("maxTimeoutSeconds must be a positive integer")
    return value


def build_requirement(
    *,
    offer: PaymentOffer,
    pay_to: str,
    max_timeout_seconds: int,
    source_tag: int,
    invoice_id: str,
    destination_tag: Optional[int] = None,
) -> dict[str, Any]:
    """Build one exact XRPL requirement.

    Native XRP intentionally retains the repository's legacy shape. Issued
    currency uses the normative XRPL x402 fields and the existing local
    source-tag/invoice bindings.
    """

    pay_to = _require_classic_address(pay_to, "pay_to")
    _require_timeout(max_timeout_seconds)
    _require_source_tag(source_tag)
    _require_invoice_id(invoice_id)

    if isinstance(offer.asset, NativeXrpAsset):
        extra: dict[str, Any] = {
            "sourceTag": source_tag,
            "invoiceId": invoice_id,
        }
    elif isinstance(offer.asset, IssuedCurrencyAsset):
        if offer.asset.issuer == pay_to:
            raise ValueError("issued-currency issuer must be distinct from payee")
        extra = {
            "areFeesSponsored": False,
            "assetTransferMethod": "sequence",
            "issuer": offer.asset.issuer,
            "sourceTag": source_tag,
            "invoiceId": invoice_id,
        }
    else:
        raise TypeError("unsupported payment asset")
    if destination_tag is not None:
        extra["destinationTag"] = _require_destination_tag(destination_tag)

    return {
        "scheme": "exact",
        "network": XRPL_TESTNET_NETWORK,
        "asset": offer.asset.currency,
        "payTo": pay_to,
        "amount": offer.amount,
        "maxTimeoutSeconds": max_timeout_seconds,
        "extra": extra,
    }


def _parse_requirement(requirement: Mapping[str, Any]) -> PaymentOffer:
    if not isinstance(requirement, Mapping):
        raise ValueError("payment requirement must be an object")
    expected_keys = {
        "scheme",
        "network",
        "asset",
        "payTo",
        "amount",
        "maxTimeoutSeconds",
        "extra",
    }
    if set(requirement) != expected_keys:
        raise ValueError("payment requirement has unsupported fields")
    if requirement.get("scheme") != "exact":
        raise ValueError("only the exact payment scheme is supported")
    _require_testnet_network(requirement.get("network"))
    pay_to = _require_classic_address(requirement.get("payTo"), "payTo")
    _require_timeout(requirement.get("maxTimeoutSeconds"))

    extra = requirement.get("extra")
    if not isinstance(extra, Mapping):
        raise ValueError("payment requirement extra must be an object")
    common_extra = {"sourceTag", "invoiceId"}
    optional_extra = {"destinationTag"}
    _require_source_tag(extra.get("sourceTag"))
    _require_invoice_id(extra.get("invoiceId"))
    if "destinationTag" in extra:
        _require_destination_tag(extra["destinationTag"])

    if requirement.get("asset") == "XRP":
        if set(extra) - common_extra - optional_extra:
            raise ValueError("legacy XRP requirement has unsupported extra fields")
        if not common_extra.issubset(extra):
            raise ValueError("legacy XRP requirement is missing bindings")
        asset: PaymentAsset = NativeXrpAsset()
    else:
        required_issued_extra = common_extra | {
            "areFeesSponsored",
            "assetTransferMethod",
            "issuer",
        }
        if set(extra) - required_issued_extra - optional_extra:
            raise ValueError("issued requirement has unsupported extra fields")
        if not required_issued_extra.issubset(extra):
            raise ValueError("issued requirement is missing required fields")
        if extra.get("areFeesSponsored") is not False:
            raise ValueError("XRPL payer must pay its own transaction fee")
        if extra.get("assetTransferMethod") != "sequence":
            raise ValueError("only sequence-issued payments are supported")
        asset = IssuedCurrencyAsset(
            currency=_require_issued_currency(requirement.get("asset")),
            issuer=_require_classic_address(extra.get("issuer"), "issuer"),
        )
        if asset.issuer == pay_to:
            raise ValueError("issued-currency issuer must be distinct from payee")
    return PaymentOffer(asset=asset, amount=requirement.get("amount"))


def parse_requirement_asset(requirement: Mapping[str, Any]) -> PaymentAsset:
    return _parse_requirement(requirement).asset


def parse_requirement_offer(requirement: Mapping[str, Any]) -> PaymentOffer:
    return _parse_requirement(requirement)
