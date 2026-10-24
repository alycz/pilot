"""Strict parser and Ed25519 verifier for the MH6 Web Bot Auth wire."""

import base64
import binascii
import re
from collections.abc import Mapping
from dataclasses import dataclass

from .context import MerchantValidationRequest
from .errors import fail


SIGNATURE_LABEL = "sig1"
SIGNATURE_AGENT_KEY = "sig1"
SIGNATURE_LIFETIME_SECONDS = 60
DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json"
REQUIRED_COMPONENTS = (
    '"@authority"',
    '"@method"',
    '"@path"',
    '"signature-agent";key="sig1"',
)
REQUIRED_COMPONENTS_WIRE = f"({' '.join(REQUIRED_COMPONENTS)})"

_RAW_FIELDS = {"signature-agent", "signature-input", "signature"}
_LABEL = r"[a-z][a-z0-9_.*-]*"
_SIGNATURE_AGENT = re.compile(
    rf'(?P<label>{_LABEL})="(?P<origin>[\x20-\x21\x23-\x5b\x5d-\x7e]+)"'
)
_SIGNATURE_INPUT = re.compile(
    rf"(?P<label>{_LABEL})="
    r"(?P<params>"
    r"(?P<components>\([^\r\n)]*\));"
    r"created=(?P<created>0|[1-9][0-9]*);"
    r"expires=(?P<expires>0|[1-9][0-9]*);"
    r'nonce="(?P<nonce>[A-Za-z0-9_-]+)";'
    r'keyid="(?P<keyid>[A-Za-z0-9_-]+)";'
    r'alg="(?P<alg>[a-z0-9-]+)";'
    r'tag="(?P<tag>[a-z0-9-]+)"'
    r")"
)
_SIGNATURE = re.compile(rf"(?P<label>{_LABEL})=:(?P<value>[A-Za-z0-9+/]+={{0,2}}):")
_AUTHORITY = re.compile(r"[A-Za-z0-9.-]+(?::[0-9]{1,5})?")
_METHOD = re.compile(r"[A-Z]{1,16}")


@dataclass(frozen=True)
class ParsedWba:
    directory_origin: str
    created: int
    expires: int
    nonce: str
    keyid: str
    alg: str
    tag: str
    signature: bytes
    signature_params: str
    signature_base: bytes


def _raw_string(evidence: Mapping[str, object], name: str) -> str:
    value = evidence.get(name)
    if not isinstance(value, str) or not value or len(value) > 2_048:
        fail("wba", "WBA_MALFORMED", f"invalid {name} header", 401)
    return value


def _decode_signature(value: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        fail("wba", "WBA_SIGNATURE_MALFORMED", "signature is not canonical base64", 401)
    if base64.b64encode(decoded).decode() != value or len(decoded) != 64:
        fail("wba", "WBA_SIGNATURE_MALFORMED", "signature is not 64-byte Ed25519", 401)
    return decoded


def _request_components(request: MerchantValidationRequest) -> tuple[str, str, str]:
    authority = request.authority
    method = request.method
    path = request.path
    if (
        not isinstance(authority, str)
        or len(authority) > 253
        or _AUTHORITY.fullmatch(authority) is None
        or authority != authority.lower()
    ):
        fail("wba", "WBA_REQUEST_TARGET_INVALID", "authority is not canonical", 401)
    if not isinstance(method, str) or _METHOD.fullmatch(method) is None:
        fail("wba", "WBA_REQUEST_TARGET_INVALID", "method is not canonical", 401)
    if (
        not isinstance(path, str)
        or not 1 <= len(path) <= 2_048
        or not path.startswith("/")
        or "?" in path
        or "#" in path
        or any(not 0x21 <= ord(character) <= 0x7E for character in path)
    ):
        fail("wba", "WBA_REQUEST_TARGET_INVALID", "path is not canonical", 401)
    return authority, method, path


def parse_wba_wire(
    evidence: object,
    request: MerchantValidationRequest,
) -> ParsedWba:
    """Parse only the exact dictionary form emitted by MH6."""

    if not isinstance(evidence, Mapping) or set(evidence) != _RAW_FIELDS:
        fail("wba", "WBA_MALFORMED", "signature header fields are not exact", 401)
    agent_match = _SIGNATURE_AGENT.fullmatch(_raw_string(evidence, "signature-agent"))
    input_match = _SIGNATURE_INPUT.fullmatch(_raw_string(evidence, "signature-input"))
    signature_match = _SIGNATURE.fullmatch(_raw_string(evidence, "signature"))
    if agent_match is None or input_match is None or signature_match is None:
        fail("wba", "WBA_MALFORMED", "signature headers are not canonical", 401)
    if (
        agent_match.group("label") != SIGNATURE_AGENT_KEY
        or input_match.group("label") != SIGNATURE_LABEL
        or signature_match.group("label") != SIGNATURE_LABEL
    ):
        fail("wba", "WBA_LABEL_MISMATCH", "signature dictionary labels do not match", 401)
    if input_match.group("components") != REQUIRED_COMPONENTS_WIRE:
        fail("wba", "WBA_COMPONENTS_INVALID", "required components are not exact", 401)
    alg = input_match.group("alg")
    if alg != "ed25519":
        fail("wba", "WBA_ALG_MISMATCH", "signature algorithm is not Ed25519", 401)
    tag = input_match.group("tag")
    if tag != "web-bot-auth":
        fail("wba", "WBA_TAG_MISMATCH", "signature tag is not web-bot-auth", 401)

    authority, method, path = _request_components(request)
    origin = agent_match.group("origin")
    parameters = input_match.group("params")
    signature_base = "\n".join(
        (
            f'"@authority": {authority}',
            f'"@method": {method}',
            f'"@path": {path}',
            f'"signature-agent";key="{SIGNATURE_AGENT_KEY}": "{origin}"',
            f'"@signature-params": {parameters}',
        )
    ).encode("ascii")
    return ParsedWba(
        directory_origin=origin,
        created=int(input_match.group("created")),
        expires=int(input_match.group("expires")),
        nonce=input_match.group("nonce"),
        keyid=input_match.group("keyid"),
        alg=alg,
        tag=tag,
        signature=_decode_signature(signature_match.group("value")),
        signature_params=parameters,
        signature_base=signature_base,
    )


def verify_ed25519_signature(parsed: ParsedWba, public_x: bytes) -> None:
    """Verify a parsed request with the selected public-only directory key."""

    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        fail("wba", "WBA_CRYPTO_UNAVAILABLE", "Ed25519 verifier unavailable", 503)
    try:
        Ed25519PublicKey.from_public_bytes(public_x).verify(
            parsed.signature,
            parsed.signature_base,
        )
    except (InvalidSignature, ValueError):
        fail("wba", "WBA_SIGNATURE_INVALID", "signature verification failed", 401)
