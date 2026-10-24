"""Web Bot Auth policy checks around the strict Ed25519 wire verifier."""

import base64
import binascii
import hashlib
import json
import re
from collections.abc import Mapping
from urllib.parse import urlsplit

from .context import (
    DirectoryDocument,
    MerchantValidationRequest,
    ValidatorDependencies,
    WbaIdentity,
)
from .errors import fail
from .wba_wire import (
    DIRECTORY_MEDIA_TYPE,
    SIGNATURE_LIFETIME_SECONDS,
    ParsedWba,
    parse_wba_wire,
    verify_ed25519_signature,
)


_THUMBPRINT = re.compile(r"^[A-Za-z0-9_-]{43}$")
_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory"


def _base64url_bytes(value: str, *, code: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        fail("wba", code, "value is not canonical base64url", 401)
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error):
        fail("wba", code, "value is not base64url", 401)
    if base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value:
        fail("wba", code, "value is not canonical base64url", 401)
    return decoded


def _origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        fail("wba", "WBA_DIRECTORY_MISMATCH", "directory must be an HTTPS origin", 401)
    canonical = f"https://{parsed.netloc}"
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != ""
        or parsed.query
        or parsed.fragment
        or parsed.netloc != parsed.netloc.lower()
        or parsed.netloc.endswith(":")
        or port == 443
        or value != canonical
    ):
        fail("wba", "WBA_DIRECTORY_MISMATCH", "directory must be an HTTPS origin", 401)
    return canonical


def _directory_identity(
    document: DirectoryDocument,
    expected_url: str,
    keyid: str,
    dependencies: ValidatorDependencies,
) -> tuple[WbaIdentity, bytes]:
    policy = dependencies.directory_policy
    if (
        policy.allow_redirects is not False
        or document.redirected is not False
        or document.final_url != expected_url
    ):
        fail("wba", "WBA_DIRECTORY_REDIRECT", "directory redirects are forbidden", 401)
    if (
        not isinstance(document.size_bytes, int)
        or isinstance(document.size_bytes, bool)
        or document.size_bytes <= 0
        or document.size_bytes > policy.max_bytes
    ):
        fail("wba", "WBA_DIRECTORY_TOO_LARGE", "directory exceeds the byte limit", 401)
    if (
        not isinstance(document.status_code, int)
        or isinstance(document.status_code, bool)
        or document.status_code != 200
    ):
        fail("wba", "WBA_DIRECTORY_STATUS_INVALID", "directory status is not 200", 401)
    if document.media_type != DIRECTORY_MEDIA_TYPE:
        fail(
            "wba",
            "WBA_DIRECTORY_MEDIA_TYPE_INVALID",
            "directory media type is not exact",
            401,
        )
    if document.cache_control != "public, max-age=300":
        fail(
            "wba",
            "WBA_DIRECTORY_CACHE_INVALID",
            "directory cache policy is not exact",
            401,
        )
    if not isinstance(document.body, Mapping):
        fail("wba", "WBA_DIRECTORY_INVALID", "directory must be an object", 401)
    try:
        canonical_size = len(
            json.dumps(document.body, sort_keys=True, separators=(",", ":")).encode()
        )
    except (TypeError, ValueError):
        fail("wba", "WBA_DIRECTORY_INVALID", "directory is not JSON", 401)
    if canonical_size > policy.max_bytes:
        fail("wba", "WBA_DIRECTORY_TOO_LARGE", "directory exceeds the byte limit", 401)
    if set(document.body) != {"keys", "xrpl_credential"}:
        fail("wba", "WBA_DIRECTORY_INVALID", "directory fields are not exact", 401)

    keys = document.body.get("keys")
    if not isinstance(keys, list) or not keys or len(keys) > policy.max_keys:
        fail("wba", "WBA_DIRECTORY_KEYS_INVALID", "directory key count is invalid", 401)
    selected: Mapping[str, object] | None = None
    seen_kids: set[str] = set()
    for candidate in keys:
        if not isinstance(candidate, Mapping) or set(candidate) != {
            "kty",
            "crv",
            "x",
            "kid",
            "use",
        }:
            fail("wba", "WBA_DIRECTORY_KEY_INVALID", "directory key fields are invalid", 401)
        candidate_kid = candidate.get("kid")
        if not isinstance(candidate_kid, str) or candidate_kid in seen_kids:
            fail("wba", "WBA_DIRECTORY_KEY_INVALID", "directory key ids are invalid", 401)
        seen_kids.add(candidate_kid)
        if candidate_kid == keyid:
            selected = candidate
    if selected is None:
        fail("wba", "WBA_KEY_NOT_FOUND", "signature key is not in the directory", 401)
    x = selected.get("x")
    if (
        selected.get("kty") != "OKP"
        or selected.get("crv") != "Ed25519"
        or selected.get("use") != "sig"
        or not isinstance(x, str)
        or len(_base64url_bytes(x, code="WBA_DIRECTORY_KEY_INVALID")) != 32
    ):
        fail("wba", "WBA_DIRECTORY_KEY_INVALID", "directory key is not public Ed25519", 401)
    canonical_jwk = json.dumps(
        {"crv": "Ed25519", "kty": "OKP", "x": x},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    thumbprint = (
        base64.urlsafe_b64encode(hashlib.sha256(canonical_jwk).digest())
        .decode()
        .rstrip("=")
    )
    if thumbprint != keyid:
        fail("wba", "WBA_DIRECTORY_KEY_INVALID", "key id is not the JWK thumbprint", 401)

    credential = document.body.get("xrpl_credential")
    if not isinstance(credential, Mapping) or set(credential) != {
        "issuer",
        "credential_type",
        "subject",
    }:
        fail("wba", "WBA_CREDENTIAL_INVALID", "directory credential link is invalid", 401)
    issuer = credential.get("issuer")
    credential_type = credential.get("credential_type")
    subject = credential.get("subject")
    if not all(isinstance(value, str) for value in (issuer, credential_type, subject)):
        fail("wba", "WBA_CREDENTIAL_INVALID", "directory credential values are invalid", 401)
    identity = WbaIdentity(issuer, credential_type, subject)
    if (
        identity.issuer != dependencies.trusted_credential_issuer
        or identity.credential_type != "AP4M-Agent"
        or identity.subject != dependencies.accepted_wba_subject
    ):
        fail("wba", "WBA_CREDENTIAL_MISMATCH", "directory credential is not accepted", 401)
    return identity, _base64url_bytes(x, code="WBA_DIRECTORY_KEY_INVALID")


async def verify_wba(
    request: MerchantValidationRequest, dependencies: ValidatorDependencies
) -> WbaIdentity:
    if request.wba is None:
        fail("wba", "WBA_REQUIRED", "Web Bot Auth signature is required", 401)
    parsed: ParsedWba = parse_wba_wire(request.wba, request)
    if dependencies.directory_loader is None:
        fail("wba", "WBA_VERIFIER_UNAVAILABLE", "identity verifier unavailable", 503)

    directory_origin = _origin(parsed.directory_origin)
    if directory_origin != _origin(dependencies.expected_wba_origin):
        fail("wba", "WBA_DIRECTORY_MISMATCH", "unexpected signature directory", 401)
    if dependencies.expected_wba_tag != "web-bot-auth" or parsed.tag != "web-bot-auth":
        fail("wba", "WBA_TAG_MISMATCH", "unexpected signature profile tag", 401)
    if not _THUMBPRINT.fullmatch(parsed.keyid):
        fail("wba", "WBA_KEYID_INVALID", "key id is not a 43-character JWK thumbprint", 401)
    if len(_base64url_bytes(parsed.nonce, code="WBA_NONCE_INVALID")) != 64:
        fail("wba", "WBA_NONCE_INVALID", "nonce must decode to 64 bytes", 401)

    now = dependencies.now()
    if not isinstance(now, int) or isinstance(now, bool) or now < 0:
        fail("wba", "WBA_CLOCK_INVALID", "validator clock is invalid", 503)
    if parsed.created < 0 or parsed.created > 9_007_199_254_740_991:
        fail("wba", "WBA_MALFORMED", "signature creation is outside the safe range", 401)
    if parsed.created > now + 5:
        fail("wba", "WBA_CREATED_IN_FUTURE", "signature creation is in the future", 401)
    if (
        parsed.expires != parsed.created + SIGNATURE_LIFETIME_SECONDS
        or parsed.expires <= now
    ):
        fail("wba", "WBA_EXPIRED", "signature lifetime is invalid", 401)
    policy = dependencies.directory_policy
    if (
        not all(
            isinstance(value, int) and not isinstance(value, bool)
            for value in (policy.max_bytes, policy.max_keys, policy.timeout_ms)
        )
        or not 1 <= policy.max_bytes <= 16_384
        or not 1 <= policy.max_keys <= 4
        or not 1 <= policy.timeout_ms <= 2_000
        or policy.allow_redirects is not False
    ):
        fail("wba", "WBA_FETCH_POLICY_INVALID", "directory fetch policy is unsafe", 503)

    directory_url = f"{directory_origin}{_DIRECTORY_PATH}"
    state = dependencies.wba_state
    cached = state.directory_cache.get(directory_url)
    active = cached if cached is not None and cached[0] > now else None
    loaded = active is None
    if active is None:
        document = await dependencies.directory_loader(directory_url, policy)
    else:
        document = active[1]
    identity, public_x = _directory_identity(
        document,
        directory_url,
        parsed.keyid,
        dependencies,
    )
    if loaded:
        state.directory_cache[directory_url] = (now + 300, document)
    verify_ed25519_signature(parsed, public_x)
    claimed = await dependencies.nonce_store.claim(
        parsed.keyid,
        parsed.nonce,
        parsed.expires,
        now,
    )
    if claimed is not True:
        fail("wba", "WBA_REPLAY", "signature nonce was already used", 401)
    return identity
