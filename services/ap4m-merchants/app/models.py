"""Strict wire models for the mock-first AP4M merchant surface."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Money(StrictModel):
    amount: str
    currency: str


class MerchantRef(StrictModel):
    srcDpaId: str
    merchantName: str
    merchantUrl: str | None = None


class IntentItem(StrictModel):
    itemId: str
    itemName: str
    itemUnitPrice: Money
    itemQuantity: int = Field(gt=0)
    itemDeliveryMethod: Literal["DIGITAL"] = "DIGITAL"


class IntentOrder(StrictModel):
    orderId: str
    orderExecutionType: Literal["IMMEDIATE", "DEFERRED"]
    orderExpiry: int
    orderTotalAmount: Money
    items: list[IntentItem] = Field(min_length=1)
    merchants: list[MerchantRef] = Field(min_length=1)


class MastercardIntent(StrictModel):
    intentId: str
    intentSummary: str
    intentStatus: Literal["ACTIVE", "REVOKED", "EXPIRED"]
    orders: list[IntentOrder] = Field(min_length=1)


class XrplExactProof(StrictModel):
    type: Literal["xrpl_exact"]
    tx_blob: str


class XrplPaychanProof(StrictModel):
    type: Literal["xrpl_paychan_claim"]
    channel_id: str
    cumulative_drops: str
    signature: str
    public_key: str


XrplPaymentProof = XrplExactProof | XrplPaychanProof


class CheckoutRequest(StrictModel):
    intent: MastercardIntent
    xrpl_payment: XrplPaymentProof | None = None
    vi_l3b: str | None = None


class ValidationChecks(StrictModel):
    agent_identity: Literal["pass", "fail", "skipped"]
    intent: Literal["pass", "fail"]
    payment: Literal["pass", "fail"]
    credential: Literal["pass", "fail"]


class IntentValidation(StrictModel):
    intentId: str
    validated: bool
    checks: ValidationChecks
    validation_errors: list[str]


class Product(StrictModel):
    sku: str
    name: str
    description: str
    price: dict[str, Any]
    price_usd_cents: int = Field(gt=0)
    response_schema_id: str
    schemes: list[Literal["exact", "xrpl-paychan"]]


class CheckoutResponse(StrictModel):
    order_id: str
    status: Literal["requires_payment", "accepted", "rejected"]
    intent_validation: IntentValidation
    data: dict[str, Any] | None = None
    challenge_state: str | None = None


class McpRequest(StrictModel):
    jsonrpc: Literal["2.0"]
    id: str | int | None = None
    method: str
    # JSON-RPC permits array params, while this server's methods require an
    # object. Preserve the raw value here so the transport can return the
    # protocol's -32602 error instead of leaking FastAPI's HTTP 422 response.
    params: Any = Field(default_factory=dict)
