"""Strict HTTP adapter from the MM1 merchant surface into the MM2 kernel."""

import base64
import binascii
import json
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass

from fastapi import Request

from validator.base import validate_checkout as validate_kernel_checkout
from validator.context import (
    ChallengeContext,
    InMemoryAtomicNonceStore,
    MerchantValidationRequest,
    ValidationOutcome,
    ValidatorDependencies,
    WbaState,
)
from validator.errors import ValidationFailure
from validator.intent import valid_intent_id
from validator.wba import verify_wba

from ..catalog import CREDENTIAL_TYPE_HEX, MOCK_CREDENTIAL_ISSUER
from ..models import IntentValidation, ValidationChecks
from .challenge import ChallengeStore, InMemoryMockChallengeStore


_ASCII = re.compile(r"^[\x20-\x7e]+$")
_PROTECTED_HEADERS: dict[str, int] = {
    "signature-agent": 512,
    "signature-input": 2_048,
    "signature": 256,
    "x-vi-l1": 16_384,
    "x-vi-l2": 16_384,
    "x-vi-l3b": 16_384,
    "x-mastercard-intent": 16_384,
    "x-ap4m-challenge-state": 128,
    "payment-signature": 24_576,
}


@dataclass(frozen=True)
class AdapterFailure(Exception):
    code: str
    message: str
    http_status: int = 400


@dataclass(frozen=True)
class IdentityOutcome:
    result: str
    http_status: int
    error_code: str | None = None


@dataclass(frozen=True)
class Mm2Runtime:
    dependencies: ValidatorDependencies
    challenge_store: ChallengeStore


def _clock() -> int:
    return int(time.time())


def build_mock_runtime() -> Mm2Runtime:
    """Build fail-closed local dependencies; callers inject all real verifiers."""

    dependencies = ValidatorDependencies(
        now=_clock,
        identity_mode="skipped",
        payment_mode="mock",
        expected_wba_origin="https://harbor.example",
        expected_wba_tag="web-bot-auth",
        accepted_wba_subject="rDemoAgent1111111111111111111111111",
        trusted_l1_issuer="did:web:mastercard.example",
        trusted_credential_issuer=MOCK_CREDENTIAL_ISSUER,
        credential_type_hex=CREDENTIAL_TYPE_HEX,
        directory_loader=None,
        vi_verifier=None,
        payment_decoder=None,
        ledger_reader=None,
        payment_transport=None,
        nonce_store=InMemoryAtomicNonceStore(),
        wba_state=WbaState(),
        allow_live=False,
    )
    return Mm2Runtime(dependencies, InMemoryMockChallengeStore(now=_clock))


def protected_headers(request: Request) -> dict[str, str]:
    """Read exact raw header occurrences, rejecting duplicates before parsing."""

    found: dict[str, list[bytes]] = {name: [] for name in _PROTECTED_HEADERS}
    for raw_name, raw_value in request.scope.get("headers", []):
        try:
            name = raw_name.decode("ascii").lower()
        except UnicodeDecodeError as exc:
            raise AdapterFailure(
                "HEADER_NAME_INVALID", "request header name is invalid"
            ) from exc
        if name in found:
            found[name].append(raw_value)
    result: dict[str, str] = {}
    for name, values in found.items():
        if len(values) > 1:
            raise AdapterFailure(
                "DUPLICATE_PROTECTED_HEADER", "protected header is duplicated"
            )
        if not values:
            continue
        try:
            value = values[0].decode("ascii")
        except UnicodeDecodeError as exc:
            raise AdapterFailure("HEADER_VALUE_INVALID", "protected header is not ASCII") from exc
        if (
            not value
            or len(values[0]) > _PROTECTED_HEADERS[name]
            or not _ASCII.fullmatch(value)
        ):
            raise AdapterFailure("HEADER_VALUE_INVALID", "protected header is invalid")
        result[name] = value
    return result


def _require(headers: Mapping[str, str], *names: str) -> None:
    if any(name not in headers for name in names):
        raise AdapterFailure(
            "REQUIRED_HEADER_MISSING", "required validation header is missing"
        )


def _decode_base64url_json(value: str, *, code: str) -> dict[str, object]:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise AdapterFailure(code, "encoded JSON header is invalid")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error) as exc:
        raise AdapterFailure(code, "encoded JSON header is invalid") from exc
    if base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
        raise AdapterFailure(code, "encoded JSON header is not canonical")
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = item
        return result

    try:
        decoded = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise AdapterFailure(code, "encoded JSON header is invalid") from exc
    if not isinstance(decoded, dict):
        raise AdapterFailure(code, "encoded JSON header must contain an object")
    canonical = json.dumps(decoded, separators=(",", ":"), ensure_ascii=False).encode()
    if raw != canonical:
        raise AdapterFailure(code, "encoded JSON header is not canonical JSON")
    return decoded


def _decode_t54_payment_signature(
    value: str,
    *,
    expected_resource: Mapping[str, object],
    expected_accepted: Mapping[str, object],
) -> dict[str, object]:
    """Decode the exact canonical padded-base64 t54 v2 payment envelope."""

    if (
        len(value) % 4 != 0
        or re.fullmatch(
            r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?",
            value,
        )
        is None
    ):
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment signature is invalid")
    padding = 2 if value.endswith("==") else 1 if value.endswith("=") else 0
    expected_size = len(value) // 4 * 3 - padding
    if expected_size <= 0 or expected_size > 24_576:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment signature is invalid")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment signature is invalid") from exc
    if len(raw) != expected_size or base64.b64encode(raw).decode() != value:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment signature is invalid")
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = item
        return result

    try:
        decoded = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment signature is invalid") from exc
    if not isinstance(decoded, dict) or list(decoded) != [
        "x402Version",
        "resource",
        "accepted",
        "payload",
    ]:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment envelope is invalid")
    if json.dumps(decoded, separators=(",", ":"), ensure_ascii=False).encode() != raw:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment envelope is not canonical")
    if decoded.get("x402Version") != 2:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment version is invalid")
    if (
        decoded.get("resource") != dict(expected_resource)
        or decoded.get("accepted") != dict(expected_accepted)
    ):
        raise AdapterFailure(
            "PAYMENT_REQUIREMENTS_MISMATCH", "payment signature does not match challenge", 402
        )
    payload = decoded.get("payload")
    if not isinstance(payload, dict) or set(payload) != {"signedTxBlob"}:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment payload is invalid")
    signed_blob = payload.get("signedTxBlob")
    if (
        not isinstance(signed_blob, str)
        or not signed_blob
        or len(signed_blob) > 16_384
        or len(signed_blob) % 2 != 0
        or re.fullmatch(r"[A-F0-9]+", signed_blob) is None
    ):
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "signed transaction is invalid")
    return {"type": "xrpl_exact", "tx_blob": signed_blob}


def _decode_payment_signature(
    value: str,
    *,
    request: Request,
    context: ChallengeContext,
) -> dict[str, object]:
    """Decode a pay-channel proof, otherwise preserve the exact t54 path."""

    if len(value) > _PROTECTED_HEADERS["payment-signature"]:
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment signature is invalid")
    try:
        raw = base64.b64decode(value, validate=True)
        decoded = json.loads(raw.decode("utf-8"))
    except (
        ValueError,
        binascii.Error,
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
    ):
        return _decode_t54_payment_signature(
            value,
            expected_resource=t54_resource(request, context),
            expected_accepted=t54_accepted(context),
        )
    paychan_wire_fields = [
        "scheme",
        "channel_id",
        "cumulative_drops",
        "signature",
        "public_key",
    ]
    if (
        isinstance(decoded, dict)
        and list(decoded) == paychan_wire_fields
        and decoded.get("scheme") == "xrpl-paychan"
        and json.dumps(decoded, separators=(",", ":"), ensure_ascii=False).encode()
        == raw
        and base64.b64encode(raw).decode() == value
    ):
        return {
            "type": "xrpl_paychan_claim",
            "channel_id": decoded["channel_id"],
            "cumulative_drops": decoded["cumulative_drops"],
            "signature": decoded["signature"],
            "public_key": decoded["public_key"],
        }
    return _decode_t54_payment_signature(
        value,
        expected_resource=t54_resource(request, context),
        expected_accepted=t54_accepted(context),
    )


def _xrpl_wire_currency(code: str) -> str:
    if re.fullmatch(r"[A-Fa-f0-9]{40}", code):
        return code.upper()
    if len(code) == 3 and code != "XRP" and re.fullmatch(
        r"[A-Za-z0-9?!@#$%&*<>(){}\[\]|]{3}", code
    ):
        return code
    encoded = code.encode("utf-8")
    if not encoded or len(encoded) > 20 or code == "XRP":
        raise AdapterFailure("CHALLENGE_STATE_INVALID", "settlement currency is invalid", 500)
    return (encoded + bytes(20 - len(encoded))).hex().upper()


def t54_resource(
    request: Request, context: ChallengeContext | None = None
) -> dict[str, object]:
    _, authority, path = trusted_request_target(request)
    scheme = request.scope.get("scheme")
    if scheme not in ("http", "https"):
        raise AdapterFailure("REQUEST_TARGET_INVALID", "trusted request scheme is invalid", 500)
    resource: dict[str, object] = {"url": f"{scheme}://{authority}{path}"}
    if context is not None:
        resource.update(
            {
                "description": context.resource_description
                or f"Typed {context.sku.replace('-', ' ')}",
                "mimeType": "application/json",
                "serviceName": context.merchant_name,
                "tags": ["ap4m", context.sku],
            }
        )
    return resource


def t54_accepted(context: ChallengeContext) -> dict[str, object]:
    if context.settlement.issuer is None:
        raise AdapterFailure(
            "PAYMENT_SCHEME_UNSUPPORTED", "exact issued-currency payment is unavailable", 402
        )
    extra: dict[str, object] = {
        "areFeesSponsored": False,
        "assetTransferMethod": "sequence",
        "invoiceId": context.invoice_id,
        "issuer": context.settlement.issuer,
        "sourceTag": context.source_tag,
    }
    if context.destination_tag is not None:
        extra["destinationTag"] = context.destination_tag
    return {
        "scheme": "exact",
        "network": "xrpl:1",
        "asset": _xrpl_wire_currency(context.settlement.code),
        "payTo": context.merchant_address,
        "amount": context.settlement.value,
        "maxTimeoutSeconds": 60,
        "extra": extra,
    }


def trusted_request_target(request: Request) -> tuple[str, str, str]:
    """Project the local ASGI target without Host or forwarding-header trust."""

    method = request.scope.get("method")
    server = request.scope.get("server")
    raw_path = request.scope.get("raw_path")
    if (
        not isinstance(method, str)
        or not _ASCII.fullmatch(method)
        or not isinstance(server, (tuple, list))
        or len(server) != 2
        or not isinstance(server[0], str)
        or not isinstance(server[1], int)
        or isinstance(server[1], bool)
        or not isinstance(raw_path, bytes)
    ):
        raise AdapterFailure(
            "REQUEST_TARGET_INVALID", "trusted request target is invalid", 500
        )
    try:
        path = raw_path.decode("ascii")
    except UnicodeDecodeError as exc:
        raise AdapterFailure("REQUEST_TARGET_INVALID", "trusted request path is invalid") from exc
    host, port = server
    if (
        not host
        or not _ASCII.fullmatch(host)
        or not path.startswith("/")
        or "?" in path
    ):
        raise AdapterFailure("REQUEST_TARGET_INVALID", "trusted request target is invalid")
    scheme = request.scope.get("scheme")
    default_port = (scheme == "https" and port == 443) or (
        scheme == "http" and port == 80
    )
    authority = host if default_port else f"{host}:{port}"
    return method.upper(), authority, path


def _wba(headers: Mapping[str, str]) -> dict[str, object]:
    _require(headers, "signature-agent", "signature-input", "signature")
    return {
        "signature-agent": headers["signature-agent"],
        "signature-input": headers["signature-input"],
        "signature": headers["signature"],
    }


def _kernel_request(
    request: Request,
    context: ChallengeContext,
    headers: Mapping[str, str],
) -> MerchantValidationRequest:
    _require(
        headers,
        "x-vi-l1",
        "x-vi-l2",
        "x-vi-l3b",
        "x-mastercard-intent",
        "x-ap4m-challenge-state",
        "payment-signature",
    )
    if headers["x-ap4m-challenge-state"] != context.state_id:
        raise AdapterFailure("CHALLENGE_STATE_MISMATCH", "challenge state does not match")
    method, authority, path = trusted_request_target(request)
    wba = _wba(headers) if "signature-agent" in headers else None
    intent = _decode_base64url_json(
        headers["x-mastercard-intent"], code="INTENT_HEADER_INVALID"
    )
    payment = _decode_payment_signature(
        headers["payment-signature"],
        request=request,
        context=context,
    )
    kernel_request = MerchantValidationRequest(
        challenge=context,
        network="testnet",
        intent=intent,
        vi_chain={
            "version": "vi-v0.1",
            "l1": headers["x-vi-l1"],
            "l2": headers["x-vi-l2"],
            "l3b": headers["x-vi-l3b"],
        },
        payment_proof=payment,
        method=method,
        authority=authority,
        path=path,
        wba=wba,
    )
    return kernel_request


async def validate_initial_identity(
    request: Request,
    context: ChallengeContext,
    runtime: Mm2Runtime,
) -> IdentityOutcome:
    dependencies = runtime.dependencies
    headers = protected_headers(request)
    if dependencies.identity_mode == "skipped":
        return IdentityOutcome("skipped", 200)
    try:
        wba = _wba(headers)
        method, authority, path = trusted_request_target(request)
        kernel_request = MerchantValidationRequest(
            challenge=context,
            network="testnet",
            intent={},
            vi_chain=None,
            payment_proof=None,
            method=method,
            authority=authority,
            path=path,
            wba=wba,
        )
        await verify_wba(kernel_request, dependencies)
    except ValidationFailure as failure:
        return IdentityOutcome("fail", failure.http_status, failure.code)
    return IdentityOutcome("pass", 200)


async def validate_paid_request(
    request: Request,
    context: ChallengeContext,
    runtime: Mm2Runtime,
    *,
    expected_intent: Mapping[str, object] | None = None,
    expected_payment: Mapping[str, object] | None = None,
) -> ValidationOutcome:
    headers = protected_headers(request)
    kernel_request = _kernel_request(request, context, headers)
    _match_expected_paid_body(kernel_request, expected_intent, expected_payment)
    return await validate_kernel_checkout(kernel_request, runtime.dependencies)


def _match_expected_paid_body(
    kernel_request: MerchantValidationRequest,
    expected_intent: Mapping[str, object] | None,
    expected_payment: Mapping[str, object] | None,
) -> None:
    if expected_intent is not None and dict(expected_intent) != dict(
        kernel_request.intent
    ):
        raise AdapterFailure("INTENT_BODY_MISMATCH", "intent body does not match header")
    if expected_payment is not None and dict(expected_payment) != dict(
        kernel_request.payment_proof or {}
    ):
        raise AdapterFailure("PAYMENT_BODY_MISMATCH", "payment body does not match header")


async def paid_retry_key(
    request: Request,
    context: ChallengeContext,
    runtime: Mm2Runtime,
    *,
    expected_intent: Mapping[str, object] | None = None,
    expected_payment: Mapping[str, object] | None = None,
) -> tuple[str, str]:
    """Project a completed-retry key without invoking settlement.

    For payment channels the second component is a domain-separated claim
    identity stored in the legacy ``payment_tx_hash`` column.  It is not an
    XRPL transaction hash and is not evidence of Testnet or live settlement.
    """

    headers = protected_headers(request)
    kernel_request = _kernel_request(request, context, headers)
    _match_expected_paid_body(kernel_request, expected_intent, expected_payment)
    intent_id = kernel_request.intent.get("intentId")
    if not valid_intent_id(intent_id):
        raise AdapterFailure("INTENT_ID_INVALID", "intent id is invalid")
    proof = kernel_request.payment_proof
    if isinstance(proof, Mapping) and proof.get("type") == "xrpl_paychan_claim":
        verifier = runtime.dependencies.paychan_verifier
        if verifier is None:
            raise AdapterFailure(
                "PAYCHAN_PENDING_MM3",
                "payment-channel settlement is not installed",
                402,
            )
        try:
            claim_id = verifier.retry_key(proof)
        except Exception as exc:
            raise AdapterFailure(
                "PAYCHAN_PROOF_MALFORMED", "channel proof is invalid"
            ) from exc
        if (
            not isinstance(claim_id, str)
            or re.fullmatch(r"[A-Fa-f0-9]{64}", claim_id) is None
        ):
            raise AdapterFailure(
                "PAYCHAN_PROOF_MALFORMED", "channel proof is invalid"
            )
        return intent_id, claim_id.upper()
    decoder = runtime.dependencies.payment_decoder
    if decoder is None:
        raise AdapterFailure(
            "PAYMENT_DECODER_UNAVAILABLE", "payment decoder unavailable", 503
        )
    tx_blob = proof.get("tx_blob") if isinstance(proof, Mapping) else None
    if not isinstance(tx_blob, str):
        raise AdapterFailure("PAYMENT_HEADER_INVALID", "payment signature is invalid")
    try:
        decoded = await decoder(tx_blob)
    except Exception as exc:
        raise AdapterFailure(
            "PAYMENT_DECODE_FAILED", "signed transaction could not be decoded"
        ) from exc
    if (
        not isinstance(decoded.tx_hash, str)
        or re.fullmatch(r"[A-Fa-f0-9]{64}", decoded.tx_hash) is None
    ):
        raise AdapterFailure("PAYMENT_HASH_INVALID", "payment hash is invalid")
    return intent_id, decoded.tx_hash.upper()


def project_outcome(outcome: ValidationOutcome) -> IntentValidation:
    return IntentValidation(
        intentId=outcome.intent_id,
        validated=outcome.validated,
        checks=ValidationChecks(
            agent_identity=outcome.checks["wba"],
            intent=outcome.checks["intent"],
            credential=outcome.checks["credential"],
            payment=outcome.checks["payment"],
        ),
        validation_errors=list(outcome.validation_errors),
    )


def pending_validation(intent_id: str) -> IntentValidation:
    return IntentValidation(
        intentId=intent_id,
        validated=False,
        checks=ValidationChecks(
            agent_identity="skipped",
            intent="fail",
            credential="fail",
            payment="fail",
        ),
        validation_errors=["PAYMENT_REQUIRED"],
    )


__all__ = [
    "AdapterFailure",
    "IdentityOutcome",
    "InMemoryMockChallengeStore",
    "Mm2Runtime",
    "build_mock_runtime",
    "pending_validation",
    "paid_retry_key",
    "project_outcome",
    "protected_headers",
    "trusted_request_target",
    "t54_accepted",
    "t54_resource",
    "validate_initial_identity",
    "validate_paid_request",
]
