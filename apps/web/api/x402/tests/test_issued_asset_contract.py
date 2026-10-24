from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from apps.web.api.x402.assets import (
    IssuedCurrencyAsset,
    NativeXrpAsset,
    PaymentOffer,
    asset_identity_key,
    build_requirement,
    exact_decimal_compare,
    exact_decimal_equal,
    is_asset_allowed,
    parse_requirement_asset,
    parse_requirement_offer,
    require_asset_allowed,
    validate_holder_to_holder,
)


RLUSD = "524C555344000000000000000000000000000000"
ISSUER = "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q"
PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn"
PAY_TO = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr"


def issued() -> IssuedCurrencyAsset:
    return IssuedCurrencyAsset(currency=RLUSD, issuer=ISSUER)


def build_issued_requirement(amount: str = "10.5") -> dict[str, object]:
    return build_requirement(
        offer=PaymentOffer(issued(), amount),
        pay_to=PAY_TO,
        max_timeout_seconds=60,
        source_tag=101,
        invoice_id="fixture-invoice",
    )


def test_assets_and_offers_are_frozen_discriminated_values() -> None:
    native = NativeXrpAsset()
    token = issued()
    assert (native.kind, native.currency, native.network) == (
        "native-xrp",
        "XRP",
        "xrpl:1",
    )
    assert (token.kind, token.currency, token.issuer, token.network) == (
        "issued-currency",
        RLUSD,
        ISSUER,
        "xrpl:1",
    )
    with pytest.raises(FrozenInstanceError):
        token.currency = "A" * 40  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        PaymentOffer(token, "1").amount = "2"  # type: ignore[misc]


@pytest.mark.parametrize("network", ["xrpl:0", "xrpl:2", "testnet", "XRPL:1"])
def test_current_profile_requires_exact_testnet_network(network: str) -> None:
    with pytest.raises(ValueError, match="xrpl:1"):
        NativeXrpAsset(network=network)
    with pytest.raises(ValueError, match="xrpl:1"):
        IssuedCurrencyAsset(RLUSD, ISSUER, network)


@pytest.mark.parametrize(
    "currency",
    ["RLUSD", "524c555344000000000000000000000000000000", "F" * 39, "G" * 40],
)
def test_issued_currency_is_exact_uppercase_40_hex(currency: str) -> None:
    with pytest.raises(ValueError, match="40 uppercase hex"):
        IssuedCurrencyAsset(currency, ISSUER)


@pytest.mark.parametrize(
    "amount",
    [
        1,
        1.5,
        "0",
        "0.0",
        "-1",
        "+1",
        ".1",
        "00.1",
        "01",
        "1.",
        "1.0",
        "1.2300",
        "1e-2",
        "NaN",
        "Infinity",
        "1234567890123456",
        "0.1234567890123456",
        "0." + "0" * 81 + "1",
    ],
)
def test_issued_amount_rejects_noncanonical_or_overprecision_values(
    amount: object,
) -> None:
    with pytest.raises(ValueError, match="canonical positive decimal"):
        PaymentOffer(issued(), amount)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "amount",
    ["1", "10.5", "0.01", "0.000000000000001", "123456789012345"],
)
def test_issued_amount_accepts_canonical_decimal_strings(amount: str) -> None:
    assert PaymentOffer(issued(), amount).amount == amount


def test_exact_decimal_comparison_never_coerces_to_float() -> None:
    assert exact_decimal_equal("1", "1")
    assert exact_decimal_compare("0.100000000000001", "0.1") == 1
    assert exact_decimal_compare("99999999999999.9", "100000000000000") == -1
    with pytest.raises(ValueError):
        exact_decimal_equal("1.0", "1")


def test_identity_and_allowlist_bind_network_currency_and_issuer() -> None:
    token = issued()
    key = f"xrpl:1:issued:{RLUSD}:{ISSUER}"
    assert asset_identity_key(token) == key
    assert asset_identity_key(NativeXrpAsset()) == "xrpl:1:native:XRP"
    assert is_asset_allowed(token, {key})
    assert require_asset_allowed(token, {key}) is token
    with pytest.raises(ValueError, match="not allowlisted"):
        require_asset_allowed(token, {f"xrpl:1:issued:{RLUSD}:{PAY_TO}"})


def test_holder_to_holder_requires_distinct_valid_parties_and_issuer() -> None:
    validate_holder_to_holder(issued(), PAYER, PAY_TO)
    for payer, pay_to in (
        (PAYER, PAYER),
        (ISSUER, PAY_TO),
        (PAYER, ISSUER),
        ("not-an-address", PAY_TO),
    ):
        with pytest.raises(ValueError):
            validate_holder_to_holder(issued(), payer, pay_to)


def test_native_requirement_preserves_legacy_shape_exactly() -> None:
    requirement = build_requirement(
        offer=PaymentOffer(NativeXrpAsset(), "5000"),
        pay_to=PAY_TO,
        max_timeout_seconds=60,
        source_tag=101,
        invoice_id="fixture-invoice",
    )
    assert requirement == {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "payTo": PAY_TO,
        "amount": "5000",
        "maxTimeoutSeconds": 60,
        "extra": {"sourceTag": 101, "invoiceId": "fixture-invoice"},
    }
    assert parse_requirement_asset(requirement) == NativeXrpAsset()
    assert parse_requirement_offer(requirement) == PaymentOffer(
        NativeXrpAsset(), "5000"
    )


def test_issued_requirement_uses_official_exact_fields_plus_local_bindings() -> None:
    requirement = build_issued_requirement()
    assert requirement == {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": RLUSD,
        "payTo": PAY_TO,
        "amount": "10.5",
        "maxTimeoutSeconds": 60,
        "extra": {
            "areFeesSponsored": False,
            "assetTransferMethod": "sequence",
            "issuer": ISSUER,
            "sourceTag": 101,
            "invoiceId": "fixture-invoice",
        },
    }
    assert parse_requirement_asset(requirement) == issued()
    assert parse_requirement_offer(requirement) == PaymentOffer(issued(), "10.5")


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("network",), "xrpl:0"),
        (("amount",), "10.50"),
        (("extra", "areFeesSponsored"), True),
        (("extra", "assetTransferMethod"), "ticketSequence"),
        (("extra", "issuer"), PAY_TO),
        (("extra", "sourceTag"), -1),
    ],
)
def test_issued_requirement_parser_rejects_mismatched_contract_fields(
    path: tuple[str, ...], value: object
) -> None:
    requirement = build_issued_requirement()
    target: dict[str, object] = requirement
    for key in path[:-1]:
        target = target[key]  # type: ignore[assignment]
    target[path[-1]] = value
    with pytest.raises(ValueError):
        parse_requirement_offer(requirement)


def test_requirement_rejects_unknown_fields_and_invalid_destination_tag() -> None:
    requirement = build_issued_requirement()
    requirement["unexpected"] = True
    with pytest.raises(ValueError, match="unsupported fields"):
        parse_requirement_asset(requirement)
    with pytest.raises(ValueError, match="destinationTag"):
        build_requirement(
            offer=PaymentOffer(issued(), "1"),
            pay_to=PAY_TO,
            max_timeout_seconds=60,
            source_tag=101,
            invoice_id="fixture-invoice",
            destination_tag=-1,
        )
