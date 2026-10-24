"""Strict Mastercard Level 3 intent validation."""

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import re

from .context import MerchantValidationRequest
from .errors import Stage, fail


@dataclass(frozen=True)
class IntentFacts:
    intent_id: str
    order_id: str
    total: Decimal
    total_usd_cents: int


_INTENT_ID = re.compile(r"^demo-intent-[A-Za-z0-9_-]{1,64}$")


def valid_intent_id(value: object) -> bool:
    return isinstance(value, str) and _INTENT_ID.fullmatch(value) is not None


def money(value: object, *, code: str, stage: Stage = "intent") -> Decimal:
    if not isinstance(value, str) or not value or "e" in value.lower():
        fail(stage, code, "amount must be a plain decimal string")
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        fail(stage, code, "amount is not decimal")
    if not parsed.is_finite() or parsed < 0:
        fail(stage, code, "amount must be finite and non-negative")
    digits = parsed.as_tuple().digits
    scale = max(0, -parsed.as_tuple().exponent)
    if len(digits) > 18 or scale > 6:
        fail(stage, code, "amount precision exceeds policy")
    return parsed


def usd_cents(value: object, *, code: str) -> int:
    parsed = money(value, code=code)
    cents = parsed * 100
    if cents != cents.to_integral_value():
        fail("intent", code, "USD amount must have at most two decimals")
    result = int(cents)
    if result < 0 or result > 9_007_199_254_740_991:
        fail("intent", code, "USD cents are outside the safe range")
    return result


def _mapping(value: object, code: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        fail("intent", code, "object is required")
    return value


def _one(value: object, code: str) -> Mapping[str, object]:
    if not isinstance(value, list) or len(value) != 1:
        fail("intent", code, "exactly one entry is required")
    return _mapping(value[0], code)


def validate_intent(request: MerchantValidationRequest, now: int) -> IntentFacts:
    intent = request.intent
    if not isinstance(intent, Mapping):
        fail("intent", "INTENT_FIELDS_INVALID", "intent must be an object")
    allowed_intent = {"intentId", "intentSummary", "intentStatus", "orders"}
    if set(intent) != allowed_intent:
        fail("intent", "INTENT_FIELDS_INVALID", "intent fields are not exact")
    intent_id = intent.get("intentId")
    if not valid_intent_id(intent_id):
        fail("intent", "INTENT_ID_INVALID", "intent id is invalid")
    summary = intent.get("intentSummary")
    if not isinstance(summary, str) or not summary or len(summary) > 500:
        fail("intent", "INTENT_SUMMARY_INVALID", "intent summary is invalid")
    if intent.get("intentStatus") != "ACTIVE":
        fail("intent", "INTENT_NOT_ACTIVE", "intent status must be ACTIVE")

    order = _one(intent.get("orders"), "INTENT_ORDER_INVALID")
    if set(order) != {
        "orderId",
        "orderExecutionType",
        "orderExpiry",
        "orderTotalAmount",
        "items",
        "merchants",
    }:
        fail("intent", "INTENT_ORDER_INVALID", "order fields are not exact")
    if order.get("orderExecutionType") != "DEFERRED":
        fail("intent", "INTENT_NOT_DEFERRED", "order must be DEFERRED")
    expiry = order.get("orderExpiry")
    if not isinstance(expiry, int) or isinstance(expiry, bool) or expiry <= now:
        fail("intent", "INTENT_EXPIRED", "order has expired")

    total = _mapping(order.get("orderTotalAmount"), "INTENT_TOTAL_INVALID")
    if set(total) != {"amount", "currency"}:
        fail("intent", "INTENT_TOTAL_INVALID", "total fields are not exact")
    if total.get("currency") != "USD":
        fail("intent", "INTENT_CURRENCY_MISMATCH", "intent authorization must use USD")
    total_amount = money(total.get("amount"), code="INTENT_TOTAL_INVALID")
    total_cents = usd_cents(total.get("amount"), code="INTENT_TOTAL_INVALID")
    price_cents = request.challenge.price_usd_cents
    if not isinstance(price_cents, int) or isinstance(price_cents, bool) or price_cents <= 0:
        fail("intent", "INTENT_PRICE_INVALID", "catalog USD cents are invalid")
    if total_cents < price_cents:
        fail("intent", "INTENT_TOTAL_TOO_LOW", "order total is below price")

    item = _one(order.get("items"), "INTENT_ITEM_INVALID")
    if set(item) != {
        "itemId",
        "itemName",
        "itemUnitPrice",
        "itemQuantity",
        "itemDeliveryMethod",
    }:
        fail("intent", "INTENT_ITEM_INVALID", "item fields are not exact")
    quantity = item.get("itemQuantity")
    if (
        item.get("itemId") != request.challenge.sku
        or not isinstance(quantity, int)
        or isinstance(quantity, bool)
        or quantity != 1
    ):
        fail("intent", "INTENT_ITEM_MISMATCH", "intent item does not match product")
    if item.get("itemDeliveryMethod") != "DIGITAL":
        fail("intent", "INTENT_ITEM_MISMATCH", "item delivery method does not match")
    unit_price = _mapping(item.get("itemUnitPrice"), "INTENT_ITEM_INVALID")
    if set(unit_price) != {"amount", "currency"}:
        fail("intent", "INTENT_ITEM_INVALID", "item price fields are not exact")
    if unit_price.get("currency") != "USD" or usd_cents(
        unit_price.get("amount"), code="INTENT_ITEM_INVALID"
    ) != price_cents:
        fail("intent", "INTENT_ITEM_MISMATCH", "item price does not match product")
    merchant = _one(order.get("merchants"), "INTENT_MERCHANT_INVALID")
    if set(merchant) not in (
        {"srcDpaId", "merchantName"},
        {"srcDpaId", "merchantName", "merchantUrl"},
    ):
        fail("intent", "INTENT_MERCHANT_INVALID", "merchant fields are not exact")
    if merchant.get("srcDpaId") != request.challenge.src_dpa_id:
        fail("intent", "INTENT_MERCHANT_MISMATCH", "merchant id does not match")
    if merchant.get("merchantName") != request.challenge.merchant_name:
        fail("intent", "INTENT_MERCHANT_MISMATCH", "merchant name does not match")

    order_id = order.get("orderId")
    if not isinstance(order_id, str) or not order_id:
        fail("intent", "INTENT_ORDER_INVALID", "order id is required")
    return IntentFacts(
        intent_id=intent_id,
        order_id=order_id,
        total=total_amount,
        total_usd_cents=total_cents,
    )
