from __future__ import annotations

import base64
import binascii
import json
import re
from json.decoder import scanstring
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence, Tuple


MAX_PAYMENT_HEADER_BYTES = 24 * 1024
MAX_PAYMENT_DECODED_BYTES = 16 * 1024
MAX_MERCHANT_BODY_BYTES = 64 * 1024
MAX_JSON_DEPTH = 16
MAX_JSON_NODES = 2_000
MAX_JSON_STRING_BYTES = 16 * 1024
MAX_JSON_KEY_BYTES = 256
MAX_INVOICE_ID_BYTES = 200
BASE64_PATTERN = re.compile(
    r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
)
HEX_PATTERN = re.compile(r"^[A-Fa-f0-9]+$")


class ProtocolError(ValueError):
    def __init__(self, code: str, status_code: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")


def encode_header(value: Any) -> str:
    return base64.b64encode(canonical_json_bytes(value)).decode("ascii")


def _preflight_json_text(
    text: str,
    *,
    depth_limit: int,
    node_limit: int,
    string_byte_limit: int,
    key_byte_limit: int,
    invalid_code: str,
    complexity_code: str,
    string_too_large_code: str,
    key_too_large_code: str,
    status_code: int,
) -> None:
    """Bound JSON structure before handing it to Python's recursive decoder."""

    containers: list[str] = []
    nodes = 0
    index = 0
    text_length = len(text)

    def count_node() -> None:
        nonlocal nodes
        nodes += 1
        if nodes > node_limit:
            raise ProtocolError(complexity_code, status_code)

    while index < text_length:
        character = text[index]
        if character in " \t\r\n,:":
            index += 1
            continue
        if character == '"':
            try:
                decoded_string, next_index = scanstring(text, index + 1, True)
                decoded_size = len(decoded_string.encode("utf-8", errors="strict"))
            except (UnicodeEncodeError, ValueError) as exc:
                raise ProtocolError(invalid_code, status_code) from exc
            lookahead = next_index
            while lookahead < text_length and text[lookahead] in " \t\r\n":
                lookahead += 1
            is_key = lookahead < text_length and text[lookahead] == ":"
            limit = key_byte_limit if is_key else string_byte_limit
            if decoded_size > limit:
                code = key_too_large_code if is_key else string_too_large_code
                raise ProtocolError(code, status_code)
            if not is_key:
                count_node()
            index = next_index
            continue
        if character in "[{":
            containers.append(character)
            if len(containers) > depth_limit:
                raise ProtocolError(complexity_code, status_code)
            count_node()
            index += 1
            continue
        if character in "]}":
            expected = "[" if character == "]" else "{"
            if not containers or containers.pop() != expected:
                raise ProtocolError(invalid_code, status_code)
            index += 1
            continue

        # A non-structural run is a primitive token. Invalid primitive syntax is
        # deliberately left to json.loads after structure has been bounded.
        count_node()
        index += 1
        while index < text_length and text[index] not in " \t\r\n,:[{]}\"":
            index += 1

    if containers:
        raise ProtocolError(invalid_code, status_code)


def decode_bounded_json_bytes(
    data: bytes,
    *,
    byte_limit: int,
    require_object: bool = False,
    depth_limit: int = MAX_JSON_DEPTH,
    node_limit: int = MAX_JSON_NODES,
    string_byte_limit: int = MAX_JSON_STRING_BYTES,
    key_byte_limit: int = MAX_JSON_KEY_BYTES,
    invalid_code: str = "invalid_json",
    too_large_code: str = "json_too_large",
    complexity_code: str = "json_complexity_exceeded",
    string_too_large_code: str = "json_string_too_large",
    key_too_large_code: str = "json_key_too_large",
    object_required_code: str = "json_object_required",
    status_code: int = 400,
    bounds_status_code: Optional[int] = None,
) -> Any:
    """Decode UTF-8 JSON only after enforcing byte and structural limits.

    Error codes are parameters so each protocol boundary can retain its own
    stable error vocabulary while sharing the same defensive parser.
    """

    if not isinstance(data, bytes):
        raise ProtocolError(invalid_code, status_code)
    if len(data) > byte_limit:
        raise ProtocolError(too_large_code, status_code)
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ProtocolError(invalid_code, status_code) from exc

    effective_bounds_status = (
        status_code if bounds_status_code is None else bounds_status_code
    )
    _preflight_json_text(
        text,
        depth_limit=depth_limit,
        node_limit=node_limit,
        string_byte_limit=string_byte_limit,
        key_byte_limit=key_byte_limit,
        invalid_code=invalid_code,
        complexity_code=complexity_code,
        string_too_large_code=string_too_large_code,
        key_too_large_code=key_too_large_code,
        status_code=effective_bounds_status,
    )
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, RecursionError, UnicodeError, ValueError) as exc:
        raise ProtocolError(invalid_code, status_code) from exc
    if require_object and not isinstance(parsed, dict):
        raise ProtocolError(object_required_code, status_code)
    return parsed


def decode_payment_header(value: str) -> Mapping[str, Any]:
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ProtocolError("invalid_payment_signature_encoding") from exc
    if len(encoded) == 0 or len(encoded) > MAX_PAYMENT_HEADER_BYTES:
        raise ProtocolError("payment_signature_too_large", 413)
    if len(encoded) % 4 != 0 or not BASE64_PATTERN.fullmatch(value):
        raise ProtocolError("invalid_payment_signature_encoding")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ProtocolError("invalid_payment_signature_encoding") from exc
    if len(decoded) > MAX_PAYMENT_DECODED_BYTES:
        raise ProtocolError("payment_signature_too_large", 413)
    if base64.b64encode(decoded) != encoded:
        raise ProtocolError("invalid_payment_signature_encoding")
    parsed = decode_bounded_json_bytes(
        decoded,
        byte_limit=MAX_PAYMENT_DECODED_BYTES,
        invalid_code="invalid_payment_signature_json",
        too_large_code="payment_signature_too_large",
        complexity_code="invalid_payment_signature_json",
        string_too_large_code="invalid_payment_signature_json",
        key_too_large_code="invalid_payment_signature_json",
        bounds_status_code=400,
    )
    if not isinstance(parsed, dict):
        raise ProtocolError("invalid_payment_signature_payload")
    assert_bounded_json(parsed, require_object=True, byte_limit=MAX_PAYMENT_DECODED_BYTES)
    return parsed


def _exact_keys(value: Mapping[str, Any], allowed: Iterable[str], code: str) -> None:
    if set(value.keys()) != set(allowed):
        raise ProtocolError(code)


def _require_dict(value: Any, code: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError(code)
    return value


def validate_payment_payload(
    payload: Mapping[str, Any],
    expected_resource: Mapping[str, Any],
    expected_requirement: Mapping[str, Any],
) -> Tuple[str, str]:
    _exact_keys(
        payload,
        ("x402Version", "resource", "accepted", "payload"),
        "unsupported_payment_control",
    )
    if payload.get("x402Version") != 2:
        raise ProtocolError("unsupported_x402_version")

    resource = _require_dict(payload.get("resource"), "invalid_resource")
    accepted = _require_dict(payload.get("accepted"), "invalid_accepted")
    scheme_payload = _require_dict(payload.get("payload"), "invalid_scheme_payload")
    _exact_keys(scheme_payload, ("signedTxBlob",), "unsupported_scheme_control")

    if resource != expected_resource:
        raise ProtocolError("resource_url_mismatch", 402)
    if accepted != expected_requirement:
        raise ProtocolError("payment_requirements_mismatch", 402)

    extra = _require_dict(accepted.get("extra"), "invalid_payment_extra")
    invoice_id = extra.get("invoiceId")
    if not isinstance(invoice_id, str) or not invoice_id.strip():
        raise ProtocolError("invalid_invoice_id")
    if len(invoice_id.encode("utf-8")) > MAX_INVOICE_ID_BYTES:
        raise ProtocolError("invalid_invoice_id")

    signed_blob = scheme_payload.get("signedTxBlob")
    if (
        not isinstance(signed_blob, str)
        or len(signed_blob) == 0
        or len(signed_blob) % 2 != 0
        or not HEX_PATTERN.fullmatch(signed_blob)
    ):
        raise ProtocolError("invalid_signed_tx_blob")
    return invoice_id, signed_blob.upper()


def assert_bounded_json(
    value: Any,
    *,
    require_object: bool,
    byte_limit: int = MAX_MERCHANT_BODY_BYTES,
) -> None:
    if require_object and not isinstance(value, dict):
        raise ProtocolError("merchant_body_must_be_object", 500)
    stack: list[Tuple[Any, int]] = [(value, 1)]
    nodes = 0
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
            raise ProtocolError("merchant_body_complexity_exceeded", 500)
        if current is None or isinstance(current, bool):
            continue
        if isinstance(current, (int, float)) and not isinstance(current, bool):
            if isinstance(current, float) and (current != current or abs(current) == float("inf")):
                raise ProtocolError("merchant_body_invalid_number", 500)
            continue
        if isinstance(current, str):
            if len(current.encode("utf-8")) > MAX_JSON_STRING_BYTES:
                raise ProtocolError("merchant_body_string_too_large", 500)
            continue
        if isinstance(current, list):
            stack.extend((child, depth + 1) for child in current)
            continue
        if isinstance(current, dict):
            for key, child in current.items():
                if not isinstance(key, str) or len(key.encode("utf-8")) > MAX_JSON_KEY_BYTES:
                    raise ProtocolError("merchant_body_key_too_large", 500)
                stack.append((child, depth + 1))
            continue
        raise ProtocolError("merchant_body_not_json", 500)
    if len(canonical_json_bytes(value)) > byte_limit:
        raise ProtocolError("merchant_body_too_large", 500)


def build_challenge(
    *,
    invoice_id: str,
    resource: Mapping[str, Any],
    pay_to: str,
    amount: str,
    timeout_seconds: int,
    source_tag: int,
    error: str = "PAYMENT-SIGNATURE header is required",
) -> Dict[str, Any]:
    return {
        "x402Version": 2,
        "error": error,
        "resource": dict(resource),
        "accepts": [
            {
                "scheme": "exact",
                "network": "xrpl:1",
                "asset": "XRP",
                "payTo": pay_to,
                "amount": amount,
                "maxTimeoutSeconds": timeout_seconds,
                "extra": {"sourceTag": source_tag, "invoiceId": invoice_id},
            }
        ],
        "extensions": {},
    }
