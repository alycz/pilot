"""Concrete AP4M projection over the pinned verifiable-intent v0.1 verifier."""

import base64
import binascii
import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ._vendor.verifiable_intent.crypto.disclosure import hash_disclosure
from ._vendor.verifiable_intent.crypto.sd_jwt import decode_sd_jwt, resolve_disclosures
from ._vendor.verifiable_intent.crypto.signing import jwk_to_public_key
from ._vendor.verifiable_intent.verification.chain import verify_chain
from .context import MerchantValidationRequest, ViVerification
from .errors import fail


REFERENCE_COMMIT = "1dc3d4189512041fb3d0f8348fe100dfe25ced91"
_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_HEX_64 = re.compile(r"^[a-fA-F0-9]{64}$")
_MAX_PRESENTATION_BYTES = 16_384
_MAX_DISCLOSURES = 64
_FORBIDDEN_RAW_OF_KEYS = {
    "account_number",
    "customer_id",
    "of_customer_id",
    "owner_name",
    "routing_number",
}


class _ReferenceRejected(ValueError):
    pass


def _reject_nonfinite(_: str) -> object:
    raise _ReferenceRejected("non-finite JSON number")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _ReferenceRejected("duplicate JSON member")
        result[key] = value
    return result


def _decode_json_segment(value: str) -> object:
    if not value or _BASE64URL.fullmatch(value) is None:
        raise _ReferenceRejected("non-canonical base64url")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error) as exc:
        raise _ReferenceRejected("invalid base64url") from exc
    if base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
        raise _ReferenceRejected("non-canonical base64url")
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_nonfinite,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise _ReferenceRejected("invalid JSON") from exc


def _preflight(serialized: object) -> str:
    if not isinstance(serialized, str) or not serialized:
        raise _ReferenceRejected("presentation is missing")
    try:
        raw = serialized.encode("ascii")
    except UnicodeEncodeError as exc:
        raise _ReferenceRejected("presentation is not ASCII") from exc
    if len(raw) > _MAX_PRESENTATION_BYTES:
        raise _ReferenceRejected("presentation is too large")
    parts = serialized.split("~")
    compact = parts[0].split(".")
    if len(compact) != 3:
        raise _ReferenceRejected("compact JWT is malformed")
    header = _decode_json_segment(compact[0])
    payload = _decode_json_segment(compact[1])
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise _ReferenceRejected("JWT header and payload must be objects")
    try:
        signature_bytes = base64.urlsafe_b64decode(
            compact[2] + "=" * (-len(compact[2]) % 4)
        )
    except (ValueError, binascii.Error) as exc:
        raise _ReferenceRejected("JWT signature is invalid") from exc
    if (
        _BASE64URL.fullmatch(compact[2]) is None
        or base64.urlsafe_b64encode(signature_bytes).decode().rstrip("=") != compact[2]
        or len(signature_bytes) != 64
    ):
        raise _ReferenceRejected("JWT signature is invalid")
    disclosures = [part for part in parts[1:] if part]
    if len(disclosures) > _MAX_DISCLOSURES:
        raise _ReferenceRejected("too many disclosures")
    if len(disclosures) != len(set(disclosures)):
        raise _ReferenceRejected("duplicate disclosure")
    for disclosure in disclosures:
        value = _decode_json_segment(disclosure)
        if not isinstance(value, list) or len(value) not in (2, 3):
            raise _ReferenceRejected("disclosure is malformed")
    return serialized


def _constraint_map(value: object, expected: set[str]) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list) or len(value) != len(expected):
        raise _ReferenceRejected("constraint set is incomplete")
    result: dict[str, dict[str, Any]] = {}
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("type"), str):
            raise _ReferenceRejected("constraint is malformed")
        kind = item["type"]
        if kind not in expected or kind in result:
            raise _ReferenceRejected("constraint set is not exact")
        result[kind] = item
    return result


def _disclosure_map(l2: Any) -> dict[str, tuple[str, object]]:
    result: dict[str, tuple[str, object]] = {}
    for encoded, value in zip(l2.disclosures, l2.disclosure_values):
        digest = hash_disclosure(encoded)
        if digest in result:
            raise _ReferenceRejected("disclosure hash collision")
        result[digest] = (encoded, value[-1])
    return result


def _reference_ids(
    value: object,
    disclosures: Mapping[str, tuple[str, object]],
    *,
    identifier: str,
) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise _ReferenceRejected("reference list is invalid")
    result: list[str] = []
    for reference in value:
        if not isinstance(reference, dict) or set(reference) != {"..."}:
            raise _ReferenceRejected("reference is malformed")
        target = disclosures.get(reference["..."])
        if target is None or not isinstance(target[1], dict):
            raise _ReferenceRejected("reference is unresolved")
        projected = target[1].get(identifier)
        if not isinstance(projected, str) or not 1 <= len(projected) <= 128:
            raise _ReferenceRejected("referenced identifier is invalid")
        result.append(projected)
    if len(result) != len(set(result)):
        raise _ReferenceRejected("referenced identifiers are duplicated")
    return tuple(result)


def _selective_merchant_l2(l2_serialized: str, l2: Any) -> str:
    disclosures = _disclosure_map(l2)
    raw_delegates = l2.payload.get("delegate_payload")
    if not isinstance(raw_delegates, list):
        raise _ReferenceRejected("L2 delegate payload is malformed")
    resolved = resolve_disclosures(l2).get("delegate_payload")
    if not isinstance(resolved, list) or len(raw_delegates) != len(resolved):
        raise _ReferenceRejected("L2 delegate payload is unresolved")
    checkout_ref: str | None = None
    checkout: dict[str, Any] | None = None
    payment_ref: str | None = None
    payment: dict[str, Any] | None = None
    for raw, value in zip(raw_delegates, resolved):
        if isinstance(value, dict) and value.get("vct") == "mandate.checkout.open":
            if checkout is not None or not isinstance(raw, dict) or set(raw) != {"..."}:
                raise _ReferenceRejected("checkout mandate is ambiguous")
            checkout_ref = raw["..."]
            checkout = value
        if isinstance(value, dict) and value.get("vct") == "mandate.payment.open":
            if payment is not None or not isinstance(raw, dict) or set(raw) != {"..."}:
                raise _ReferenceRejected("payment mandate is ambiguous")
            payment_ref = raw["..."]
            payment = value
    if (
        checkout is None
        or checkout_ref not in disclosures
        or payment is None
        or payment_ref not in disclosures
    ):
        raise _ReferenceRejected("merchant mandate pair is missing")
    constraints = _constraint_map(
        checkout.get("constraints"),
        {"mandate.checkout.allowed_merchant", "mandate.checkout.line_items"},
    )
    line_items = constraints["mandate.checkout.line_items"].get("items")
    if not isinstance(line_items, list) or not line_items:
        raise _ReferenceRejected("checkout line items are missing")
    payment_constraints = _constraint_map(
        payment.get("constraints"),
        {
            "payment.amount",
            "payment.budget",
            "payment.allowed_payee",
            "payment.agent_recurrence",
            "payment.reference",
        },
    )
    payee_refs = payment_constraints["payment.allowed_payee"].get("allowed_payees")
    if not isinstance(payee_refs, list) or not payee_refs:
        raise _ReferenceRejected("payment payees are missing")
    selected = [disclosures[payment_ref][0]]
    seen = {payment_ref}
    for reference in payee_refs:
        if not isinstance(reference, dict) or set(reference) != {"..."}:
            raise _ReferenceRejected("payment payee reference is malformed")
        digest = reference["..."]
        if digest in seen or digest not in disclosures:
            raise _ReferenceRejected("payment payee reference is invalid")
        seen.add(digest)
        selected.append(disclosures[digest][0])
    if checkout_ref in seen:
        raise _ReferenceRejected("checkout reference is duplicated")
    seen.add(checkout_ref)
    selected.append(disclosures[checkout_ref][0])
    for line in line_items:
        if not isinstance(line, dict) or not isinstance(line.get("acceptable_items"), list):
            raise _ReferenceRejected("checkout line item is malformed")
        for reference in line["acceptable_items"]:
            if not isinstance(reference, dict) or set(reference) != {"..."}:
                raise _ReferenceRejected("checkout item reference is malformed")
            digest = reference["..."]
            if digest in seen or digest not in disclosures:
                raise _ReferenceRejected("checkout item reference is invalid")
            seen.add(digest)
            selected.append(disclosures[digest][0])
    return "~".join([l2_serialized.split("~", 1)[0], *selected, ""])


def _contains_raw_open_finance(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            key in _FORBIDDEN_RAW_OF_KEYS or _contains_raw_open_finance(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_raw_open_finance(item) for item in value)
    return False


@dataclass(frozen=True)
class PinnedReferenceViVerifier:
    """Verify L1/L2/L3b with the exact v0.1 reference and project AP4M claims."""

    issuer_public_jwk: Mapping[str, object]
    expected_issuer_kid: str
    expected_l2_audience: str

    def __post_init__(self) -> None:
        if not isinstance(self.issuer_public_jwk, Mapping):
            raise ValueError("issuer JWK must be an object")
        if (
            not isinstance(self.expected_issuer_kid, str)
            or not 1 <= len(self.expected_issuer_kid) <= 128
            or not isinstance(self.expected_l2_audience, str)
            or not 1 <= len(self.expected_l2_audience) <= 512
        ):
            raise ValueError("pinned VI verifier configuration is invalid")

    async def __call__(
        self,
        chain: Mapping[str, object],
        request: MerchantValidationRequest,
    ) -> ViVerification:
        try:
            return self._verify(chain, request)
        except _ReferenceRejected:
            fail(
                "intent",
                "VI_REFERENCE_INVALID",
                "pinned verifiable-intent reference rejected the chain",
            )

    def _verify(
        self,
        chain: Mapping[str, object],
        request: MerchantValidationRequest,
    ) -> ViVerification:
        mandate_id = request.expected_mandate_id
        l3_nonce = request.expected_l3_nonce
        if (
            not isinstance(mandate_id, str)
            or not mandate_id
            or len(mandate_id) > 128
            or not isinstance(l3_nonce, str)
            or not l3_nonce
            or len(l3_nonce) > 128
        ):
            raise _ReferenceRejected("trusted prepared VI state is missing")
        l1_raw = _preflight(chain.get("l1"))
        l2_raw = _preflight(chain.get("l2"))
        l3b_raw = _preflight(chain.get("l3b"))
        try:
            l1 = decode_sd_jwt(l1_raw)
            l2 = decode_sd_jwt(l2_raw)
            l3b = decode_sd_jwt(l3b_raw)
            issuer_key = jwk_to_public_key(dict(self.issuer_public_jwk))
        except (KeyError, TypeError, ValueError) as exc:
            raise _ReferenceRejected("reference input is malformed") from exc
        if l1.header.get("kid") != self.expected_issuer_kid:
            raise _ReferenceRejected("issuer key id does not match")
        selective_l2 = _selective_merchant_l2(l2_raw, l2)
        result = verify_chain(
            l1,
            l2,
            l3_checkout=l3b,
            issuer_public_key=issuer_key,
            clock_skew_seconds=0,
            l1_serialized=l1_raw,
            l2_serialized=l2_raw,
            l2_checkout_serialized=selective_l2,
            expected_l2_aud=self.expected_l2_audience,
            expected_l2_nonce=mandate_id,
            expected_l3_checkout_aud=f"https://{request.authority}",
            expected_l3_checkout_nonce=l3_nonce,
        )
        allowed_skips = {
            "l1_card_id_cross_check",
            "l3_cross_reference (requires both L3a and L3b)",
        }
        required_checks = {
            "l2_aud",
            "l2_nonce",
            "l2_reference_binding",
            "pair_0_identity_binding",
            "l3b_(checkout)_aud",
            "l3b_(checkout)_nonce",
            "l3b_(checkout)_structural_chain",
        }
        if (
            result.valid is not True
            or result.errors
            or result.mandate_pair_count != 1
            or any(skip not in allowed_skips for skip in result.checks_skipped)
            or not required_checks.issubset(result.checks_performed)
            or len(result.pair_results) != 1
        ):
            raise _ReferenceRejected("reference chain checks failed")
        pair = result.pair_results[0]
        l1_claims = result.l1_claims
        l2_claims = result.l2_claims
        checkout = pair.checkout_mandate
        payment = pair.payment_mandate
        l3_delegates = result.l3_checkout_claims.get("delegate_payload")
        if not isinstance(l3_delegates, list):
            raise _ReferenceRejected("L3 checkout disclosure is missing")
        l3_checkout = [
            item
            for item in l3_delegates
            if isinstance(item, dict) and item.get("vct") == "mandate.checkout"
        ]
        if len(l3_checkout) != 1:
            raise _ReferenceRejected("L3 checkout disclosure is ambiguous")
        checkout_claim = l3_checkout[0]
        checkout_jwt = checkout_claim.get("checkout_jwt")
        checkout_hash = checkout_claim.get("checkout_hash")
        if (
            not isinstance(checkout_jwt, str)
            or not isinstance(checkout_hash, str)
            or base64.urlsafe_b64encode(
                hashlib.sha256(checkout_jwt.encode("utf-8")).digest()
            )
            .decode()
            .rstrip("=")
            != checkout_hash
        ):
            raise _ReferenceRejected("checkout digest does not bind")

        disclosures = _disclosure_map(l2)
        checkout_constraints = _constraint_map(
            checkout.get("constraints"),
            {"mandate.checkout.allowed_merchant", "mandate.checkout.line_items"},
        )
        payment_constraints = _constraint_map(
            payment.get("constraints"),
            {
                "payment.amount",
                "payment.budget",
                "payment.allowed_payee",
                "payment.agent_recurrence",
                "payment.reference",
            },
        )
        amount = payment_constraints["payment.amount"]
        recurrence = payment_constraints["payment.agent_recurrence"]
        reference = payment_constraints["payment.reference"]
        if (
            amount.get("currency") != "USD"
            or not isinstance(amount.get("max"), int)
            or isinstance(amount.get("max"), bool)
            or amount["max"] < 0
            or recurrence.get("frequency") != "ON_DEMAND"
            or reference.get("conditional_transaction_id") != pair.pairing_key
        ):
            raise _ReferenceRejected("payment constraints are invalid")
        instrument = payment.get("payment_instrument")
        if (
            not isinstance(instrument, dict)
            or instrument.get("type") != "xrpl.ap4m"
            or not isinstance(instrument.get("id"), str)
        ):
            raise _ReferenceRejected("payment instrument is invalid")
        merchants = _reference_ids(
            checkout_constraints["mandate.checkout.allowed_merchant"].get(
                "allowed_merchants"
            ),
            disclosures,
            identifier="id",
        )
        payees = _reference_ids(
            payment_constraints["payment.allowed_payee"].get("allowed_payees"),
            disclosures,
            identifier="id",
        )
        lines = checkout_constraints["mandate.checkout.line_items"].get("items")
        if not isinstance(lines, list) or not lines:
            raise _ReferenceRejected("line items are missing")
        item_refs: list[object] = []
        for line in lines:
            if not isinstance(line, dict) or not isinstance(line.get("acceptable_items"), list):
                raise _ReferenceRejected("line item is malformed")
            item_refs.extend(line["acceptable_items"])
        skus = _reference_ids(item_refs, disclosures, identifier="sku")
        owner_hash = l1_claims.get("of_owner_name_hash")
        customer_ref = l1_claims.get("of_customer_ref")
        l1_issuer = l1_claims.get("iss")
        owner = l2_claims.get("iss")
        budget_account = l1_claims.get("budget_account")
        expiries = [l1_claims.get("exp"), l2_claims.get("exp"), l3b.payload.get("exp")]
        if (
            not isinstance(owner_hash, str)
            or _HEX_64.fullmatch(owner_hash) is None
            or not isinstance(customer_ref, str)
            or _HEX_64.fullmatch(customer_ref) is None
            or not isinstance(l1_issuer, str)
            or not 1 <= len(l1_issuer) <= 512
            or not isinstance(owner, str)
            or not 1 <= len(owner) <= 128
            or not isinstance(budget_account, str)
            or not 1 <= len(budget_account) <= 128
            or not all(
                isinstance(value, int) and not isinstance(value, bool)
                for value in expiries
            )
        ):
            raise _ReferenceRejected("AP4M L1 claims are incomplete")
        return ViVerification(
            signatures_valid=True,
            l1_l2_bound=True,
            l2_l3_bound=True,
            l1_issuer=l1_issuer,
            owner=owner,
            budget_account=budget_account,
            payer=instrument["id"],
            of_verified=l1_claims.get("of_verified") is True,
            of_owner_name_hash=owner_hash.lower(),
            of_customer_ref=customer_ref.lower(),
            raw_of_identifiers_present=_contains_raw_open_finance(l1_claims),
            allowed_payees=payees,
            allowed_merchants=merchants,
            allowed_skus=skus,
            per_payment_max_usd_cents=amount["max"],
            constraint_currency="USD",
            recurrence="ON_DEMAND",
            expires_at=min(expiries),
            checkout_hash=checkout_hash,
        )
