from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from xrpl.core.addresscodec import is_valid_classic_address

from .assets import (
    IssuedCurrencyAsset,
    canonical_issued_value,
    parse_requirement_asset,
)


APPROVAL_EXTENSION_KEY = "pilot.x402.owner-approval"
APPROVAL_DOMAIN = "pilot.x402.owner-approval"
APPROVAL_EXTENSION_OFFER = {
    "version": 1,
    "required": True,
    "domain": APPROVAL_DOMAIN,
}
HASH = re.compile(r"^[A-F0-9]{64}$")
OPAQUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$")
POSITIVE_DROPS = re.compile(r"^[1-9][0-9]*$")
ISO_MILLISECONDS = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"
)
UINT32_MAX = 0xFFFF_FFFF


class ApprovalEnvelopeError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _reject(code: str) -> None:
    raise ApprovalEnvelopeError(code)


def _exact_keys(value: Mapping[str, Any], expected: set[str], code: str) -> None:
    if set(value) != expected:
        _reject(code)


def _mapping(value: Any, code: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        _reject(code)
    return value


def _opaque(value: Any, code: str) -> str:
    if not isinstance(value, str) or not OPAQUE.fullmatch(value):
        _reject(code)
    return value


def _uint32(value: Any, code: str, *, positive: bool = False) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < (1 if positive else 0)
        or value > UINT32_MAX
    ):
        _reject(code)
    return value


def _classic_address(value: Any, code: str) -> str:
    if not isinstance(value, str) or not is_valid_classic_address(value):
        _reject(code)
    return value


def approval_extension_offer() -> dict[str, Any]:
    return {
        APPROVAL_EXTENSION_KEY: dict(APPROVAL_EXTENSION_OFFER),
    }


def extract_issued_approval_envelope(
    payment_payload: Mapping[str, Any],
) -> Mapping[str, Any]:
    extensions = _mapping(
        payment_payload.get("extensions"), "semantic_approval_envelope_required"
    )
    _exact_keys(
        extensions,
        {APPROVAL_EXTENSION_KEY},
        "unsupported_semantic_approval_extension",
    )
    extension = _mapping(
        extensions.get(APPROVAL_EXTENSION_KEY), "invalid_semantic_approval_extension"
    )
    _exact_keys(
        extension,
        {"version", "envelope"},
        "invalid_semantic_approval_extension",
    )
    if extension.get("version") != 1:
        _reject("unsupported_semantic_approval_version")
    return _mapping(extension.get("envelope"), "invalid_semantic_approval_envelope")


def validate_issued_approval_envelope(
    value: Mapping[str, Any],
    *,
    requirement: Mapping[str, Any],
    resource: Mapping[str, Any],
    expected_merchant_id: Optional[str] = None,
    expected_first_ledger_sequence: Optional[int] = None,
    expected_resource_method: str = "POST",
    approval_now: Optional[float] = None,
) -> Mapping[str, Any]:
    envelope = _mapping(value, "invalid_semantic_approval_envelope")
    _exact_keys(
        envelope,
        {
            "version",
            "domain",
            "approval_id",
            "network",
            "execution_network",
            "session_scope",
            "idempotency_key",
            "merchant",
            "asset",
            "amount",
            "owner",
            "quote_expires_at",
            "merchant_invoice_id",
            "transaction",
        },
        "invalid_semantic_approval_envelope",
    )
    if (
        envelope.get("version") != 1
        or envelope.get("domain") != APPROVAL_DOMAIN
        or envelope.get("network") != "xrpl:1"
        or envelope.get("execution_network") != "testnet"
    ):
        _reject("semantic_approval_contract_mismatch")
    _opaque(envelope.get("approval_id"), "invalid_semantic_approval_identifier")
    _opaque(envelope.get("session_scope"), "invalid_semantic_approval_identifier")
    _opaque(envelope.get("idempotency_key"), "invalid_semantic_approval_identifier")

    merchant = _mapping(envelope.get("merchant"), "invalid_semantic_merchant")
    _exact_keys(
        merchant,
        {"id", "resource_method", "resource_url", "pay_to"},
        "invalid_semantic_merchant",
    )
    merchant_id = _opaque(merchant.get("id"), "invalid_semantic_merchant")
    if expected_merchant_id is not None and merchant_id != expected_merchant_id:
        _reject("semantic_merchant_mismatch")
    if (
        merchant.get("resource_method") != "POST"
        or merchant.get("resource_method") != expected_resource_method
        or merchant.get("resource_url") != resource.get("url")
        or merchant.get("pay_to") != requirement.get("payTo")
    ):
        _reject("semantic_merchant_mismatch")

    payment_asset = parse_requirement_asset(requirement)
    if not isinstance(payment_asset, IssuedCurrencyAsset):
        _reject("semantic_approval_issued_asset_required")
    asset = _mapping(envelope.get("asset"), "invalid_semantic_approval_asset")
    _exact_keys(
        asset,
        {"kind", "network", "namespace", "currency", "issuer"},
        "invalid_semantic_approval_asset",
    )
    if asset != {
        "kind": "issued",
        "network": "xrpl:1",
        "namespace": "token",
        "currency": payment_asset.currency,
        "issuer": payment_asset.issuer,
    }:
        _reject("semantic_approval_asset_mismatch")
    try:
        amount = canonical_issued_value(envelope.get("amount"))
    except ValueError as exc:
        raise ApprovalEnvelopeError("invalid_semantic_approval_amount") from exc
    if amount != requirement.get("amount"):
        _reject("semantic_approval_amount_mismatch")

    owner = _classic_address(envelope.get("owner"), "invalid_semantic_approval_owner")
    if owner in {payment_asset.issuer, requirement.get("payTo")}:
        _reject("semantic_approval_owner_mismatch")
    quote_expires_at = envelope.get("quote_expires_at")
    if not isinstance(quote_expires_at, str) or not ISO_MILLISECONDS.fullmatch(
        quote_expires_at
    ):
        _reject("invalid_semantic_approval_expiry")
    try:
        quote_expiry = datetime.strptime(
            quote_expires_at, "%Y-%m-%dT%H:%M:%S.%fZ"
        ).replace(tzinfo=timezone.utc).timestamp()
    except ValueError as exc:
        raise ApprovalEnvelopeError("invalid_semantic_approval_expiry") from exc
    if approval_now is not None and not (
        approval_now < quote_expiry <= approval_now + 5 * 60
    ):
        _reject("semantic_approval_expired_or_unbounded")
    merchant_invoice_id = envelope.get("merchant_invoice_id")
    if (
        not isinstance(merchant_invoice_id, str)
        or not merchant_invoice_id.strip()
        or len(merchant_invoice_id.encode("utf-8")) > 200
        or merchant_invoice_id != requirement.get("extra", {}).get("invoiceId")
    ):
        _reject("semantic_merchant_invoice_mismatch")

    transaction = _mapping(
        envelope.get("transaction"), "invalid_semantic_approval_transaction"
    )
    _exact_keys(
        transaction,
        {
            "fee_drops",
            "sequence",
            "last_ledger_sequence",
            "source_tag",
            "validated_ledger_index",
        },
        "invalid_semantic_approval_transaction",
    )
    fee = transaction.get("fee_drops")
    if not isinstance(fee, str) or not POSITIVE_DROPS.fullmatch(fee):
        _reject("invalid_semantic_approval_transaction")
    _uint32(
        transaction.get("sequence"),
        "invalid_semantic_approval_transaction",
        positive=True,
    )
    validated_ledger = _uint32(
        transaction.get("validated_ledger_index"),
        "invalid_semantic_approval_transaction",
        positive=True,
    )
    last_ledger = _uint32(
        transaction.get("last_ledger_sequence"),
        "invalid_semantic_approval_transaction",
        positive=True,
    )
    source_tag = _uint32(
        transaction.get("source_tag"), "invalid_semantic_approval_transaction"
    )
    extra = requirement.get("extra")
    if not isinstance(extra, Mapping) or source_tag != extra.get("sourceTag"):
        _reject("semantic_approval_transaction_mismatch")
    timeout = requirement.get("maxTimeoutSeconds")
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
        _reject("semantic_approval_transaction_mismatch")
    expected_last = validated_ledger + min(20, math.ceil(timeout / 5) + 2)
    if last_ledger != expected_last:
        _reject("semantic_approval_transaction_mismatch")
    if (
        expected_first_ledger_sequence is not None
        and validated_ledger + 1 != expected_first_ledger_sequence
    ):
        _reject("semantic_approval_ledger_basis_mismatch")
    return envelope


def canonical_issued_approval_envelope(value: Mapping[str, Any]) -> str:
    """Canonicalize the strict v1 envelope exactly like Harbor's TS helper."""

    def canonical(item: Any) -> str:
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, bool) or not isinstance(item, (int, Mapping)):
            _reject("invalid_semantic_approval_envelope")
        if isinstance(item, int):
            if abs(item) > 9_007_199_254_740_991:
                _reject("invalid_semantic_approval_envelope")
            return str(item)
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":"))
            + ":"
            + canonical(item[key])
            for key in sorted(item)
        ) + "}"

    try:
        return canonical(value)
    except (UnicodeEncodeError, TypeError, ValueError) as exc:
        if isinstance(exc, ApprovalEnvelopeError):
            raise
        raise ApprovalEnvelopeError("invalid_semantic_approval_envelope") from exc


def digest_issued_approval_envelope(value: Mapping[str, Any]) -> str:
    try:
        encoded = canonical_issued_approval_envelope(value).encode("utf-8", "strict")
    except UnicodeEncodeError as exc:
        raise ApprovalEnvelopeError("invalid_semantic_approval_envelope") from exc
    return hashlib.sha256(encoded).hexdigest().upper()


def validate_issued_envelope_transaction(
    envelope: Mapping[str, Any],
    transaction: Mapping[str, Any],
    requirement: Mapping[str, Any],
    resource: Mapping[str, Any],
) -> str:
    validated = validate_issued_approval_envelope(
        envelope,
        requirement=requirement,
        resource=resource,
    )
    transaction_binding = validated["transaction"]
    if (
        transaction.get("Account") != validated["owner"]
        or transaction.get("Destination") != validated["merchant"]["pay_to"]
        or transaction.get("Fee") != transaction_binding["fee_drops"]
        or transaction.get("Sequence") != transaction_binding["sequence"]
        or transaction.get("LastLedgerSequence")
        != transaction_binding["last_ledger_sequence"]
        or transaction.get("SourceTag") != transaction_binding["source_tag"]
    ):
        _reject("semantic_approval_transaction_mismatch")
    digest = digest_issued_approval_envelope(validated)
    invoice_id = transaction.get("InvoiceID")
    raw_invoice_hash = hashlib.sha256(
        validated["merchant_invoice_id"].encode("utf-8")
    ).hexdigest().upper()
    if invoice_id == raw_invoice_hash and invoice_id != digest:
        _reject("legacy_raw_invoice_hash_rejected")
    if invoice_id != digest:
        _reject("semantic_approval_digest_mismatch")
    if not HASH.fullmatch(digest):
        _reject("semantic_approval_digest_mismatch")
    return digest
