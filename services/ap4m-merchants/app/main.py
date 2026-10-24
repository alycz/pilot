"""Mock-first AP4M merchant service implementing Mastercard Level 3 discovery."""

import base64
import json
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from paychan import PaychanFailure, build_disabled_runtime

from .catalog import MERCHANTS, merchant, product, product_data
from .events import events
from .models import CheckoutRequest, CheckoutResponse, McpRequest, Product
from .validator import (
    AdapterFailure,
    ChallengeStateError,
    build_mock_runtime,
    pending_validation,
    project_outcome,
    protected_headers,
    t54_accepted,
    t54_resource,
    validate_initial_identity,
    validate_paid_request,
)
from .validator.base import paid_retry_key


app = FastAPI(
    title="AP4M demo merchants",
    version="0.1.0",
    description=(
        "Mock-first XRPL Testnet merchant surfaces following Mastercard's Level 3 "
        "Agentic Commerce guide. No Mastercard payment network is connected."
    ),
)

_orders: dict[tuple[str, str], dict[str, Any]] = {}
_mcp_sessions: set[str] = set()
app.state.mm2_runtime = build_mock_runtime()
app.state.mm3_runtime = build_disabled_runtime()


class PaychanSettleRequest(BaseModel):
    """Optional channel selection for an explicit merchant settlement."""

    model_config = ConfigDict(extra="forbid")

    channel_id: str | None = Field(
        default=None,
        pattern=r"^[A-Fa-f0-9]{64}$",
    )


_PAYCHAN_SETTLE_ERRORS: dict[str, tuple[int, str]] = {
    "PAYCHAN_NO_PENDING": (409, "no pending payment-channel claim"),
    "PAYCHAN_CHANNEL_REQUIRED": (409, "channel id is required"),
    "PAYCHAN_SETTLEMENT_DISABLED": (503, "payment-channel settlement is unavailable"),
    "PAYCHAN_SUBMIT_FAILED": (502, "payment-channel settlement failed"),
    "PAYCHAN_NOT_REDEEMED": (402, "payment-channel redemption was not validated"),
    "PAYCHAN_REDEEM_RACE": (409, "a newer payment-channel claim must be settled"),
    "PAYCHAN_SETTLEMENT_UNCERTAIN": (
        409,
        "payment-channel settlement outcome is uncertain",
    ),
    "PAYCHAN_EVENT_PENDING": (
        503,
        "payment-channel redemption event is pending",
    ),
}


def _safe_validation_errors(
    exc: ValidationError | RequestValidationError,
) -> list[dict[str, Any]]:
    """Return validation metadata without echoing attacker-controlled inputs."""

    return [
        {
            "type": error.get("type", "validation_error"),
            "loc": list(error.get("loc", ())),
            "msg": error.get("msg", "invalid value"),
        }
        for error in exc.errors()
    ]


@app.exception_handler(RequestValidationError)
async def safe_request_validation_error(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": _safe_validation_errors(exc)})


@app.middleware("http")
async def record_request(request: Request, call_next):
    if not request.url.path.startswith("/events"):
        path_parts = request.url.path.split("/")
        merchant_id = path_parts[2] if len(path_parts) > 2 and path_parts[1] == "m" else "all"
        await events.append(
            "received",
            merchant_id=merchant_id,
            action=request.url.path,
            method=request.method,
        )
    return await call_next(request)


def _merchant_or_404(merchant_id: str):
    try:
        return merchant(merchant_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _product_or_404(merchant_id: str, sku: str) -> dict[str, Any]:
    try:
        return product(merchant_id, sku)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _challenge(
    context, seller, item: dict[str, Any], request: Request
) -> dict[str, Any]:
    accepts: list[dict[str, Any]] = []
    if "exact" in seller.schemes:
        accepts.append(t54_accepted(context))
    if "xrpl-paychan" in seller.schemes:
        accepts.append(
            {
                "scheme": "xrpl-paychan",
                "network": "xrpl:1",
                "amount": "50000",
                "asset": {"kind": "xrp"},
                "payTo": seller.xrpl_address,
            }
        )
    return {
        "x402Version": 2,
        "error": "payment_required",
        "resource": t54_resource(request, context),
        "accepts": accepts,
        "extensions": {
            "ap4m": {
                "challengeState": context.state_id,
                "merchantId": seller.id,
                "sku": context.sku,
                "requiredCredential": "AP4M-Agent",
                "priceUsdCents": context.price_usd_cents,
                "l3aDigest": context.l3a_digest,
                "ledger": {
                    "networkId": context.network_id,
                    "currentIndex": context.current_ledger_index,
                    "maxLastLedgerDelta": context.max_last_ledger_delta,
                    "maxFeeDrops": context.max_fee_drops,
                },
            },
        },
    }


async def _append_validation_events(outcome) -> None:
    for event in outcome.events:
        await events.append(
            event.stage,
            merchant_id=event.merchant_id,
            sku=event.sku,
            intent_id=event.intent_id,
            result=event.result,
            error_code=event.error_code,
        )


def _adapter_error(failure: AdapterFailure | ChallengeStateError) -> JSONResponse:
    status = failure.http_status if isinstance(failure, AdapterFailure) else 400
    return JSONResponse(
        status_code=status,
        content={"error": failure.code, "message": failure.message},
    )


def _paychan_settle_error(failure: PaychanFailure) -> JSONResponse:
    error = _PAYCHAN_SETTLE_ERRORS.get(failure.code)
    if error is None:
        return JSONResponse(
            status_code=500,
            content={
                "error": "PAYCHAN_SETTLEMENT_FAILED",
                "message": "payment-channel settlement failed",
            },
        )
    status, message = error
    return JSONResponse(
        status_code=status,
        content={"error": failure.code, "message": message},
    )


async def _issue_challenge(
    merchant_id: str, sku: str, request: Request
) -> tuple[dict[str, Any], str] | JSONResponse:
    seller = _merchant_or_404(merchant_id)
    item = _product_or_404(merchant_id, sku)
    runtime = app.state.mm2_runtime
    try:
        state_id, context = runtime.challenge_store.prepare(seller, item)
        identity = await validate_initial_identity(request, context, runtime)
    except (AdapterFailure, ChallengeStateError) as failure:
        return _adapter_error(failure)
    await events.append(
        "wba",
        merchant_id=merchant_id,
        sku=sku,
        intent_id="demo-intent-unverified",
        result=identity.result,
        error_code=identity.error_code,
    )
    if identity.result == "fail":
        return JSONResponse(
            status_code=identity.http_status,
            content={"error": identity.error_code or "WBA_FAILED"},
        )
    try:
        await runtime.challenge_store.publish(context)
    except ChallengeStateError as failure:
        return _adapter_error(failure)
    return _challenge(context, seller, item, request), state_id


async def _validate_acquired_paid_request(
    request: Request,
    merchant_id: str,
    sku: str,
    state_id: str,
    *,
    expected_intent=None,
    expected_payment=None,
):
    """Recover an exact completion or reserve and validate one paid retry."""

    runtime = app.state.mm2_runtime
    completed_context = await runtime.challenge_store.completed_context(state_id)
    if completed_context is not None:
        if completed_context.merchant_id != merchant_id or completed_context.sku != sku:
            raise AdapterFailure(
                "CHALLENGE_STATE_MISMATCH", "challenge state does not match resource"
            )
        intent_id, tx_hash = await paid_retry_key(
            request,
            completed_context,
            runtime,
            expected_intent=expected_intent,
            expected_payment=expected_payment,
        )
        cached = await runtime.challenge_store.recover(state_id, intent_id, tx_hash)
        if cached is None:
            raise ChallengeStateError(
                "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
            )
        return completed_context, None, cached, None
    context = await runtime.challenge_store.get(state_id)
    if context.merchant_id != merchant_id or context.sku != sku:
        raise AdapterFailure(
            "CHALLENGE_STATE_MISMATCH", "challenge state does not match resource"
        )
    intent_id, tx_hash = await paid_retry_key(
        request,
        context,
        runtime,
        expected_intent=expected_intent,
        expected_payment=expected_payment,
    )
    try:
        lease = await runtime.challenge_store.acquire_fenced(
            state_id, intent_id, tx_hash
        )
    except ChallengeStateError as failure:
        if failure.code != "CHALLENGE_STATE_EXPIRED":
            raise
        # A concurrent first request may have completed between get and acquire.
        completed_context = await runtime.challenge_store.completed_context(state_id)
        if completed_context is None:
            raise
        cached = await runtime.challenge_store.recover(state_id, intent_id, tx_hash)
        if cached is None:
            raise failure
        return completed_context, None, cached, None
    if lease.checkpoint is not None:
        await runtime.challenge_store.complete(
            state_id,
            lease.intent_id,
            lease.payment_tx_hash,
            lease.checkpoint,
            lease.owner_token,
        )
        return context, None, lease.checkpoint, None
    try:
        outcome = await validate_paid_request(
            request,
            context,
            runtime,
            expected_intent=expected_intent,
            expected_payment=expected_payment,
        )
    except BaseException:
        await runtime.challenge_store.release(state_id, lease.owner_token)
        raise
    if not outcome.validated:
        await runtime.challenge_store.release(state_id, lease.owner_token)
        return context, outcome, None, None
    return context, outcome, None, lease


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "mode": "mock",
        "network": "XRPL Testnet",
        "merchants": sorted(MERCHANTS),
    }


@app.get("/m/{merchant_id}/api/v1/agentic/products")
async def list_products(merchant_id: str) -> dict[str, Any]:
    seller = _merchant_or_404(merchant_id)
    await events.append("received", merchant_id=merchant_id, action="list_products")
    return {"products": [Product.model_validate(item).model_dump() for item in seller.products]}


@app.get("/m/{merchant_id}/api/v1/agentic/products/{sku}")
async def get_product(merchant_id: str, sku: str) -> dict[str, Any]:
    await events.append("received", merchant_id=merchant_id, sku=sku, action="get_product")
    return Product.model_validate(_product_or_404(merchant_id, sku)).model_dump()


@app.post("/m/{merchant_id}/api/v1/agentic/checkout", response_model=None)
async def create_checkout(
    merchant_id: str, body: CheckoutRequest, request: Request
) -> CheckoutResponse | JSONResponse:
    _merchant_or_404(merchant_id)
    return await _perform_checkout(merchant_id, body, request)


async def _perform_checkout(
    merchant_id: str,
    body: CheckoutRequest,
    request: Request,
) -> CheckoutResponse | JSONResponse:
    order = body.intent.orders[0]
    sku = order.items[0].itemId
    _product_or_404(merchant_id, sku)
    await events.append("received", merchant_id=merchant_id, sku=sku, action="checkout")
    if body.xrpl_payment is None:
        issued = await _issue_challenge(merchant_id, sku, request)
        if isinstance(issued, JSONResponse):
            return issued
        _, state_id = issued
        response = CheckoutResponse(
            order_id=f"order-{uuid4()}",
            status="requires_payment",
            intent_validation=pending_validation(body.intent.intentId),
            challenge_state=state_id,
        )
        _orders[(merchant_id, response.order_id)] = response.model_dump()
        return response

    try:
        headers = protected_headers(request)
        state_id = headers.get("x-ap4m-challenge-state")
        if state_id is None:
            raise AdapterFailure(
                "REQUIRED_HEADER_MISSING", "required validation header is missing"
            )
        context, outcome, cached, lease = await _validate_acquired_paid_request(
            request,
            merchant_id,
            sku,
            state_id,
            expected_intent=body.intent.model_dump(),
            expected_payment=body.xrpl_payment.model_dump(),
        )
    except (AdapterFailure, ChallengeStateError) as failure:
        return _adapter_error(failure)
    if cached is not None:
        response = CheckoutResponse.model_validate(cached)
        _orders[(merchant_id, response.order_id)] = response.model_dump()
        return response
    assert outcome is not None
    await _append_validation_events(outcome)
    validation = project_outcome(outcome)
    order_id = f"order-{uuid4()}"
    response = CheckoutResponse(
        order_id=order_id,
        status="accepted" if outcome.validated else "rejected",
        intent_validation=validation,
        data=product_data(merchant_id, sku) if outcome.validated else None,
        challenge_state=context.state_id,
    )
    if outcome.validated:
        if outcome.tx_hash is None:
            return _adapter_error(
                ChallengeStateError(
                    "PAYMENT_HASH_INVALID", "validated payment hash is missing"
                )
            )
        assert lease is not None
        if outcome.tx_hash.upper() != lease.payment_tx_hash:
            return _adapter_error(
                ChallengeStateError(
                    "PAYMENT_HASH_MISMATCH", "validated payment hash does not match"
                )
            )
        try:
            result = response.model_dump(mode="json")
            await app.state.mm2_runtime.challenge_store.checkpoint(lease, result)
            await app.state.mm2_runtime.challenge_store.complete(
                context.state_id,
                outcome.intent_id,
                outcome.tx_hash,
                result,
                lease.owner_token,
            )
        except ChallengeStateError as failure:
            return _adapter_error(failure)
    _orders[(merchant_id, order_id)] = response.model_dump()
    return response


@app.get("/m/{merchant_id}/api/v1/agentic/order/{order_id}")
async def get_order(merchant_id: str, order_id: str) -> dict[str, Any]:
    _merchant_or_404(merchant_id)
    try:
        return _orders[(merchant_id, order_id)]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="unknown order") from exc


@app.post("/m/{merchant_id}/settle", response_model=None)
async def settle_paychan_claim(
    merchant_id: str,
    body: PaychanSettleRequest | None = None,
) -> dict[str, Any] | JSONResponse:
    """Redeem the highest verified channel claim via an injected submitter."""

    _merchant_or_404(merchant_id)
    channel_id = body.channel_id.upper() if body and body.channel_id else None
    try:
        result = await app.state.mm3_runtime.settle(merchant_id, channel_id)
    except PaychanFailure as failure:
        return _paychan_settle_error(failure)
    payload = {
        "channel_id": result.channel_id,
        "cumulative_drops": result.cumulative_drops,
        "tx_hash": result.tx_hash,
        "replayed": result.replayed,
    }
    # PaychanRuntime is the single event authority. It emits claim_redeemed only
    # after durable redemption succeeds, including for automatic settlement.
    # Emitting here as well would duplicate the console-triggered event.
    return payload


@app.get("/m/{merchant_id}/resource/{sku}")
async def paid_resource(merchant_id: str, sku: str, request: Request):
    seller = _merchant_or_404(merchant_id)
    item = _product_or_404(merchant_id, sku)
    await events.append("received", merchant_id=merchant_id, sku=sku, action="resource")
    try:
        headers = protected_headers(request)
    except AdapterFailure as failure:
        return _adapter_error(failure)
    if "payment-signature" not in headers:
        issued = await _issue_challenge(merchant_id, sku, request)
        if isinstance(issued, JSONResponse):
            return issued
        challenge, state_id = issued
        return JSONResponse(
            status_code=402,
            content=challenge,
            headers={
                "X-AP4M-Challenge-State": state_id,
                "PAYMENT-REQUIRED": base64.b64encode(
                    json.dumps(
                        challenge,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ).encode()
                ).decode(),
            },
        )

    try:
        state_id = headers.get("x-ap4m-challenge-state")
        if state_id is None:
            raise AdapterFailure(
                "REQUIRED_HEADER_MISSING", "required validation header is missing"
            )
        context, outcome, cached, lease = await _validate_acquired_paid_request(
            request, merchant_id, sku, state_id
        )
    except (AdapterFailure, ChallengeStateError) as failure:
        return _adapter_error(failure)
    if cached is not None:
        return cached
    assert outcome is not None
    await _append_validation_events(outcome)
    validation = project_outcome(outcome)
    if outcome.validated:
        response = {
            "data": product_data(merchant_id, sku),
            "intent_validation": validation.model_dump(),
        }
        if outcome.tx_hash is None:
            return _adapter_error(
                ChallengeStateError(
                    "PAYMENT_HASH_INVALID", "validated payment hash is missing"
                )
            )
        assert lease is not None
        if outcome.tx_hash.upper() != lease.payment_tx_hash:
            return _adapter_error(
                ChallengeStateError(
                    "PAYMENT_HASH_MISMATCH", "validated payment hash does not match"
                )
            )
        try:
            await app.state.mm2_runtime.challenge_store.checkpoint(lease, response)
            await app.state.mm2_runtime.challenge_store.complete(
                context.state_id,
                outcome.intent_id,
                outcome.tx_hash,
                response,
                lease.owner_token,
            )
        except ChallengeStateError as failure:
            return _adapter_error(failure)
        await events.append(
            "served",
            merchant_id=merchant_id,
            sku=sku,
            intent_id=outcome.intent_id,
            result="pass",
        )
        return response
    return JSONResponse(
        status_code=outcome.http_status,
        content={
            **_challenge(context, seller, item, request),
            "error": (
                outcome.validation_errors[0]
                if outcome.validation_errors
                else "VALIDATION_FAILED"
            ),
            "intent_validation": validation.model_dump(),
        },
    )


@app.get("/m/{merchant_id}/agents.txt", response_class=PlainTextResponse)
async def agents_txt(merchant_id: str) -> str:
    _merchant_or_404(merchant_id)
    await events.append("received", merchant_id=merchant_id, action="agents_txt")
    return (
        f"# {merchant_id}\n"
        f"OpenAPI: /openapi.json\n"
        f"MCP: /m/{merchant_id}/mcp\n"
        f"Products: /m/{merchant_id}/api/v1/agentic/products\n"
    )


@app.get("/robots.txt", response_class=PlainTextResponse)
async def robots_txt() -> str:
    await events.append("received", merchant_id="all", action="robots_txt")
    return "User-agent: *\nAllow: /m/\nSitemap: /openapi.json\n"


def _mcp_tools(merchant_id: str) -> list[dict[str, Any]]:
    _merchant_or_404(merchant_id)
    return [
        {
            "name": "search-products",
            "description": "Search the merchant product catalog",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "additionalProperties": False,
            },
        },
        {
            "name": "get-product-details",
            "description": "Read one product by sku",
            "inputSchema": {
                "type": "object",
                "properties": {"sku": {"type": "string"}},
                "required": ["sku"],
                "additionalProperties": False,
            },
        },
        {
            "name": "create-checkout",
            "description": "Create a Level 3-shaped checkout with xrpl_payment",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "intent": {"type": "object"},
                    "xrpl_payment": {"type": "object"},
                    "vi_l3b": {"type": "string"},
                },
                "required": ["intent"],
                "additionalProperties": False,
            },
        },
    ]


def _mcp_error(
    request_id: str | int | None,
    code: int,
    message: str,
    data: Any | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


@app.get("/m/{merchant_id}/mcp")
async def mcp_info(merchant_id: str) -> dict[str, Any]:
    await events.append("received", merchant_id=merchant_id, action="mcp_get")
    return {"transport": "streamable-http", "tools": _mcp_tools(merchant_id)}


@app.post("/m/{merchant_id}/mcp")
async def mcp_call(
    merchant_id: str,
    request: Request,
):
    _merchant_or_404(merchant_id)
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            content=_mcp_error(None, -32700, "parse error"),
            status_code=200,
        )
    if not isinstance(payload, dict):
        return JSONResponse(
            content=_mcp_error(None, -32600, "invalid request"),
            status_code=200,
        )
    request_id = payload.get("id")
    try:
        body = McpRequest.model_validate(payload)
    except ValidationError as exc:
        return JSONResponse(
            content=_mcp_error(
                request_id, -32600, "invalid request", _safe_validation_errors(exc)
            ),
            status_code=200,
        )
    is_notification = "id" not in payload
    await events.append("received", merchant_id=merchant_id, action="mcp", method=body.method)
    session_id = request.headers.get("mcp-session-id")
    if session_id and session_id not in _mcp_sessions:
        raise HTTPException(status_code=404, detail="unknown MCP session")

    if not isinstance(body.params, dict):
        if is_notification:
            return Response(status_code=202)
        return _mcp_error(body.id, -32602, "invalid params: expected object")

    if body.method == "initialize":
        created_session = str(uuid4())
        _mcp_sessions.add(created_session)
        if is_notification:
            return Response(status_code=202)
        return JSONResponse(
            content={
                "jsonrpc": "2.0",
                "id": body.id,
                "result": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": f"ap4m-{merchant_id}", "version": "0.1.0"},
                    "instructions": (
                        "Mock-first XRPL Testnet merchant. Payment validation is unavailable "
                        "until MM2 and always fails closed."
                    ),
                },
            },
            headers={"Mcp-Session-Id": created_session},
        )
    if body.method == "notifications/initialized":
        return Response(status_code=202)
    if body.method == "tools/list":
        result: Any = {"tools": _mcp_tools(merchant_id)}
    elif body.method == "tools/call":
        name = body.params.get("name")
        arguments = body.params.get("arguments", {})
        if not isinstance(name, str) or not isinstance(arguments, dict):
            if is_notification:
                return Response(status_code=202)
            return _mcp_error(body.id, -32602, "invalid tool-call params")
        try:
            if name == "search-products":
                query = str(arguments.get("query", "")).lower()
                result = {
                    "products": [
                        item
                        for item in MERCHANTS[merchant_id].products
                        if query in f"{item['sku']} {item['name']} {item['description']}".lower()
                    ]
                }
            elif name == "get-product-details":
                result = _product_or_404(merchant_id, str(arguments.get("sku", "")))
            elif name == "create-checkout":
                checkout_result = await _perform_checkout(
                    merchant_id,
                    CheckoutRequest.model_validate(arguments),
                    request,
                )
                if isinstance(checkout_result, JSONResponse):
                    if is_notification:
                        return Response(status_code=202)
                    return _mcp_error(
                        body.id,
                        -32602,
                        "checkout validation failed",
                    )
                result = checkout_result.model_dump()
            else:
                if is_notification:
                    return Response(status_code=202)
                return _mcp_error(body.id, -32601, f"unknown MCP tool: {name}")
        except ValidationError as exc:
            if is_notification:
                return Response(status_code=202)
            return _mcp_error(
                body.id,
                -32602,
                "invalid tool arguments",
                _safe_validation_errors(exc),
            )
        except HTTPException as exc:
            if is_notification:
                return Response(status_code=202)
            return _mcp_error(body.id, -32602, str(exc.detail))
    else:
        if is_notification:
            return Response(status_code=202)
        return _mcp_error(body.id, -32601, f"unknown MCP method: {body.method}")
    if is_notification:
        return Response(status_code=202)
    protocol_result = {
        "content": [{"type": "text", "text": json.dumps(result, sort_keys=True)}],
        "structuredContent": result,
        "isError": False,
    } if body.method == "tools/call" else result
    return {"jsonrpc": "2.0", "id": body.id, "result": protocol_result}


@app.get("/events")
async def event_stream(after: int = 0) -> StreamingResponse:
    async def encode():
        async for event in events.stream(after):
            yield f"id: {event['id']}\nevent: {event['kind']}\ndata: {json.dumps(event)}\n\n"

    return StreamingResponse(encode(), media_type="text/event-stream")


@app.get("/events/snapshot")
async def event_snapshot() -> dict[str, Any]:
    return {"events": events.snapshot()}
