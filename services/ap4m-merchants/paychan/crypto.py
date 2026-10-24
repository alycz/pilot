"""XRPL PaymentChannelClaim signing-claim encoding and local verification."""

import hashlib
import re

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .context import ClaimProof


_HEX_64 = re.compile(r"^[0-9A-Fa-f]{64}$")
_HEX_PUBLIC_KEY = re.compile(r"^(?:(?:02|03)|ED)[0-9A-Fa-f]{64}$")
_HEX_SIGNATURE = re.compile(r"^[0-9A-Fa-f]+$")
_UINT = re.compile(r"^(?:0|[1-9][0-9]*)$")
_UINT64_MAX = (1 << 64) - 1
_SECP256K1_ORDER = int(
    "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16
)
_CLAIM_PREFIX = b"CLM\x00"


class LocalVerifierUnavailable(RuntimeError):
    """Raised only when the local crypto implementation cannot run."""


def canonical_drops(value: object, *, allow_zero: bool = False) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 20
        or not _UINT.fullmatch(value)
    ):
        raise ValueError("drops must be a canonical unsigned integer string")
    amount = int(value)
    if amount > _UINT64_MAX or (amount == 0 and not allow_zero):
        raise ValueError("drops are outside the uint64 range")
    return value


def normalize_proof(proof: ClaimProof) -> ClaimProof:
    if not _HEX_64.fullmatch(proof.channel_id):
        raise ValueError("channel_id must be 32-byte hex")
    canonical_drops(proof.cumulative_drops)
    if not _HEX_PUBLIC_KEY.fullmatch(proof.public_key):
        raise ValueError("public_key must be a supported XRPL claim key")
    if (
        not proof.signature
        or len(proof.signature) > 144
        or len(proof.signature) % 2
        or not _HEX_SIGNATURE.fullmatch(proof.signature)
    ):
        raise ValueError("signature must be hex")
    if proof.public_key.upper().startswith("ED") and len(proof.signature) != 128:
        raise ValueError("Ed25519 signature must be 64-byte hex")
    return ClaimProof(
        channel_id=proof.channel_id.upper(),
        cumulative_drops=proof.cumulative_drops,
        signature=proof.signature.upper(),
        public_key=proof.public_key.upper(),
    )


def signing_claim_bytes(channel_id: str, cumulative_drops: str) -> bytes:
    """Encode exactly `CLM\0 || uint256(channel) || uint64(balance)`.

    This is the same binary preimage used by rippled `channel_verify` and
    xrpl-py's payment-channel signing helper.
    """

    if not _HEX_64.fullmatch(channel_id):
        raise ValueError("channel_id must be 32-byte hex")
    canonical_drops(cumulative_drops)
    return (
        _CLAIM_PREFIX
        + bytes.fromhex(channel_id)
        + int(cumulative_drops).to_bytes(8, byteorder="big", signed=False)
    )


def verify_claim_signature(proof: ClaimProof) -> bool:
    """Verify an XRPL secp256k1 or Ed25519 payment-channel signature locally."""

    proof = normalize_proof(proof)
    message = signing_claim_bytes(proof.channel_id, proof.cumulative_drops)
    if proof.public_key.startswith("ED"):
        try:
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(proof.public_key[2:])).verify(
                bytes.fromhex(proof.signature), message
            )
        except InvalidSignature:
            return False
        except (ValueError, TypeError, RuntimeError) as exc:
            raise LocalVerifierUnavailable("local Ed25519 verifier unavailable") from exc
        return True
    try:
        signature = bytes.fromhex(proof.signature)
        r, s = utils.decode_dss_signature(signature)
    except (ValueError, TypeError):
        return False
    if (
        not 1 <= r < _SECP256K1_ORDER
        or not 1 <= s <= _SECP256K1_ORDER // 2
        or utils.encode_dss_signature(r, s) != signature
    ):
        return False
    digest = hashlib.sha512(message).digest()[:32]
    try:
        key = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256K1(), bytes.fromhex(proof.public_key)
        )
        key.verify(
            signature,
            digest,
            ec.ECDSA(utils.Prehashed(hashes.SHA256())),
        )
    except InvalidSignature:
        return False
    except (ValueError, TypeError, RuntimeError) as exc:
        raise LocalVerifierUnavailable("local secp256k1 verifier unavailable") from exc
    return True

