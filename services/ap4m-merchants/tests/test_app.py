import asyncio

from fastapi.testclient import TestClient

from app.events import EventRing
from app.main import app


client = TestClient(app)


def intent() -> dict:
    return {
        "intentId": "demo-intent-test",
        "intentSummary": "Buy a yield report",
        "intentStatus": "ACTIVE",
        "orders": [
            {
                "orderId": "order-input",
                "orderExecutionType": "DEFERRED",
                "orderExpiry": 2_000_000_000,
                "orderTotalAmount": {"amount": "1", "currency": "USD"},
                "items": [
                    {
                        "itemId": "yield-report",
                        "itemName": "Venue yield report",
                        "itemUnitPrice": {"amount": "1", "currency": "USD"},
                        "itemQuantity": 1,
                        "itemDeliveryMethod": "DIGITAL",
                    }
                ],
                "merchants": [
                    {
                        "srcDpaId": "demo-dpa-venue-yield-desk",
                        "merchantName": "Venue Yield Desk",
                    }
                ],
            }
        ],
    }


def test_health_is_explicitly_mock_testnet() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["mode"] == "mock"
    assert response.json()["network"] == "XRPL Testnet"


def test_both_merchants_expose_typed_products() -> None:
    for merchant_id, sku in (
        ("venue-yield-desk", "yield-report"),
        ("risk-oracle", "risk-score"),
    ):
        listing = client.get(f"/m/{merchant_id}/api/v1/agentic/products")
        assert listing.status_code == 200
        assert listing.json()["products"][0]["sku"] == sku
        detail = client.get(f"/m/{merchant_id}/api/v1/agentic/products/{sku}")
        assert detail.status_code == 200
        assert detail.json()["response_schema_id"].endswith("_v1")


def test_resource_returns_x402_challenge_without_accepting_payment() -> None:
    response = client.get("/m/venue-yield-desk/resource/yield-report")
    assert response.status_code == 402
    challenge = response.json()
    assert [entry["scheme"] for entry in challenge["accepts"]] == [
        "exact",
        "xrpl-paychan",
    ]
    assert all(entry["network"] == "xrpl:1" for entry in challenge["accepts"])
    assert response.headers["PAYMENT-REQUIRED"]

    retry = client.get(
        "/m/venue-yield-desk/resource/yield-report",
        headers={"PAYMENT-SIGNATURE": "mock-proof-must-not-be-accepted"},
    )
    assert retry.status_code == 400
    assert retry.json()["error"] == "REQUIRED_HEADER_MISSING"
    assert "mock-proof-must-not-be-accepted" not in retry.text


def test_checkout_and_resource_share_safe_validator_seam() -> None:
    response = client.post(
        "/m/venue-yield-desk/api/v1/agentic/checkout",
        json={"intent": intent()},
    )
    assert response.status_code == 200
    checkout = response.json()
    assert checkout["status"] == "requires_payment"
    assert checkout["intent_validation"] == {
        "intentId": "demo-intent-test",
        "validated": False,
        "checks": {
            "agent_identity": "skipped",
            "intent": "fail",
            "payment": "fail",
            "credential": "fail",
        },
        "validation_errors": ["PAYMENT_REQUIRED"],
    }
    assert len(checkout["challenge_state"]) == 43
    stored = client.get(
        f"/m/venue-yield-desk/api/v1/agentic/order/{checkout['order_id']}"
    )
    assert stored.status_code == 200
    assert client.get(
        f"/m/risk-oracle/api/v1/agentic/order/{checkout['order_id']}"
    ).status_code == 404


def test_mcp_and_agent_discovery() -> None:
    info = client.get("/m/risk-oracle/mcp")
    assert [tool["name"] for tool in info.json()["tools"]] == [
        "search-products",
        "get-product-details",
        "create-checkout",
    ]
    initialized = client.post(
        "/m/risk-oracle/mcp",
        json={
            "jsonrpc": "2.0",
            "id": "init",
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    session = initialized.headers["mcp-session-id"]
    assert initialized.json()["result"]["capabilities"] == {"tools": {}}

    called = client.post(
        "/m/risk-oracle/mcp",
        headers={"Mcp-Session-Id": session},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "search-products", "arguments": {"query": "risk"}},
        },
    )
    assert called.status_code == 200
    assert called.json()["result"]["structuredContent"]["products"][0]["sku"] == "risk-score"
    assert "OpenAPI" in client.get("/m/risk-oracle/agents.txt").text
    assert "Allow: /m/" in client.get("/robots.txt").text


def test_mcp_create_checkout_uses_the_same_fail_closed_validator() -> None:
    response = client.post(
        "/m/venue-yield-desk/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "create-checkout",
                "arguments": {"intent": intent()},
            },
        },
    )
    assert response.status_code == 200
    result = response.json()["result"]["structuredContent"]
    assert result["status"] == "requires_payment"
    assert result["intent_validation"]["validated"] is False


def test_mcp_errors_are_protocol_shaped() -> None:
    invalid = client.post(
        "/m/venue-yield-desk/mcp",
        json={
            "jsonrpc": "2.0",
            "id": "invalid",
            "method": "tools/call",
            "params": {"name": "create-checkout", "arguments": {}},
        },
    )
    assert invalid.status_code == 200
    assert invalid.json()["error"]["code"] == -32602

    unknown = client.post(
        "/m/venue-yield-desk/mcp",
        json={
            "jsonrpc": "2.0",
            "id": "unknown",
            "method": "tools/call",
            "params": {"name": "not-a-tool", "arguments": {}},
        },
    )
    assert unknown.status_code == 200
    assert unknown.json()["error"]["code"] == -32601

    unknown_method = client.post(
        "/m/venue-yield-desk/mcp",
        json={
            "jsonrpc": "2.0",
            "id": "unknown-method",
            "method": "resources/list",
            "params": {},
        },
    )
    assert unknown_method.status_code == 200
    assert unknown_method.json() == {
        "jsonrpc": "2.0",
        "id": "unknown-method",
        "error": {
            "code": -32601,
            "message": "unknown MCP method: resources/list",
        },
    }


def test_mcp_envelope_and_params_validation_are_protocol_shaped() -> None:
    invalid_request = client.post(
        "/m/venue-yield-desk/mcp",
        json={"jsonrpc": "1.0", "id": "bad-envelope", "method": "tools/list"},
    )
    assert invalid_request.status_code == 200
    assert invalid_request.json()["error"]["code"] == -32600
    assert invalid_request.json()["id"] == "bad-envelope"

    missing_version = client.post(
        "/m/venue-yield-desk/mcp",
        json={"id": "missing-version", "method": "tools/list"},
    )
    assert missing_version.status_code == 200
    assert missing_version.json()["error"]["code"] == -32600

    invalid_params = client.post(
        "/m/venue-yield-desk/mcp",
        json={
            "jsonrpc": "2.0",
            "id": "bad-params",
            "method": "tools/call",
            "params": [],
        },
    )
    assert invalid_params.status_code == 200
    assert invalid_params.json() == {
        "jsonrpc": "2.0",
        "id": "bad-params",
        "error": {"code": -32602, "message": "invalid params: expected object"},
    }


def test_mcp_notifications_return_no_json_rpc_result() -> None:
    notification = client.post(
        "/m/venue-yield-desk/mcp",
        json={
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {},
        },
    )
    assert notification.status_code == 202
    assert notification.content == b""

    invalid_notification_params = client.post(
        "/m/venue-yield-desk/mcp",
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": [],
        },
    )
    assert invalid_notification_params.status_code == 202
    assert invalid_notification_params.content == b""


def test_event_snapshot_has_structured_received_events() -> None:
    client.get("/health")
    checkout = client.post(
        "/m/venue-yield-desk/api/v1/agentic/checkout",
        json={"intent": intent()},
    ).json()
    order_path = (
        "/m/venue-yield-desk/api/v1/agentic/order/"
        f"{checkout['order_id']}"
    )
    client.get(order_path)
    events = client.get("/events/snapshot").json()["events"]
    received_actions = {
        event["action"]
        for event in events
        if event["kind"] == "received"
    }
    assert "/health" in received_actions
    assert order_path in received_actions
    assert all("at" in event and "id" in event for event in events)


def test_event_ids_are_monotonic_after_ring_wrap() -> None:
    ring = EventRing(capacity=2)

    async def append_three() -> None:
        await ring.append("received")
        await ring.append("intent")
        await ring.append("payment")

    asyncio.run(append_three())
    assert [event["id"] for event in ring.snapshot()] == [2, 3]


def test_unknown_merchant_and_unknown_fields_fail_closed() -> None:
    assert client.get("/m/nope/api/v1/agentic/products").status_code == 404
    payload = {"intent": intent(), "unexpected": True}
    assert client.post(
        "/m/venue-yield-desk/api/v1/agentic/checkout", json=payload
    ).status_code == 422
