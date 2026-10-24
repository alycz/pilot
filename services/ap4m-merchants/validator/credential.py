"""XRPL proof decoding and AP4M-Agent credential validation."""

import re
from collections.abc import Mapping
from dataclasses import dataclass

from .context import (
    DecodedPayment,
    MerchantValidationRequest,
    ValidatorDependencies,
    WbaIdentity,
)
from .errors import fail


_HEX_64 = re.compile(r"^[A-Fa-f0-9]{64}$")
_TX_BLOB = re.compile(r"^[A-Fa-f0-9]+$")
RIPPLE_EPOCH_UNIX_OFFSET = 946_684_800


def ripple_epoch_to_unix(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        fail("credential", "CREDENTIAL_EXPIRY_INVALID", "Ripple epoch expiry is invalid")
    unix = value + RIPPLE_EPOCH_UNIX_OFFSET
    if unix > 9_007_199_254_740_991:
        fail("credential", "CREDENTIAL_EXPIRY_INVALID", "credential expiry overflows")
    return unix


@dataclass(frozen=True)
class CredentialFacts:
    scheme: str
    payer: str
    payment: DecodedPayment | None


async def _check_record(
    credential_id: str,
    payer: str,
    dependencies: ValidatorDependencies,
) -> None:
    if dependencies.ledger_reader is None:
        fail("credential", "LEDGER_READER_UNAVAILABLE", "ledger reader unavailable", 503)
    record = await dependencies.ledger_reader.read_credential(credential_id)
    if (
        not isinstance(record.credential_id, str)
        or not _HEX_64.fullmatch(record.credential_id)
        or record.credential_id.lower() != credential_id.lower()
    ):
        fail("credential", "CREDENTIAL_ID_MISMATCH", "credential id does not match")
    if record.accepted is not True:
        fail("credential", "CREDENTIAL_NOT_ACCEPTED", "credential is not accepted")
    if record.expiration_ripple is not None:
        expiration_unix = ripple_epoch_to_unix(record.expiration_ripple)
        if expiration_unix <= dependencies.now():
            fail("credential", "CREDENTIAL_EXPIRED", "credential has expired")
    if (
        not isinstance(record.issuer, str)
        or record.issuer != dependencies.trusted_credential_issuer
    ):
        fail("credential", "CREDENTIAL_ISSUER_MISMATCH", "credential issuer does not match")
    if (
        not isinstance(record.credential_type, str)
        or record.credential_type.upper() != dependencies.credential_type_hex.upper()
    ):
        fail("credential", "CREDENTIAL_TYPE_MISMATCH", "credential type does not match")
    if not isinstance(record.subject, str) or record.subject != payer:
        fail(
            "credential",
            "CREDENTIAL_SUBJECT_MISMATCH",
            "credential subject does not match payer",
        )


async def verify_credential(
    request: MerchantValidationRequest,
    dependencies: ValidatorDependencies,
    authorized_payer: str,
    wba_identity: WbaIdentity | None,
) -> CredentialFacts:
    proof = request.payment_proof
    if proof is None:
        fail("credential", "PAYMENT_PROOF_REQUIRED", "XRPL payment proof is required", 402)
    if not isinstance(proof, Mapping):
        fail("credential", "PAYMENT_PROOF_MALFORMED", "payment proof must be an object")
    proof_type = proof.get("type")
    if proof_type == "xrpl_exact":
        if set(proof) != {"type", "tx_blob"}:
            fail("credential", "PAYMENT_PROOF_MALFORMED", "exact proof fields are not exact")
        tx_blob = proof.get("tx_blob")
        if (
            not isinstance(tx_blob, str)
            or not tx_blob
            or len(tx_blob) > 16_384
            or len(tx_blob) % 2 != 0
            or not _TX_BLOB.fullmatch(tx_blob)
        ):
            fail("credential", "PAYMENT_PROOF_MALFORMED", "transaction blob is invalid")
        if dependencies.payment_decoder is None:
            fail("credential", "PAYMENT_DECODER_UNAVAILABLE", "payment decoder unavailable", 503)
        payment = await dependencies.payment_decoder(tx_blob)
        if (
            not isinstance(payment.credential_ids, tuple)
            or not 1 <= len(payment.credential_ids) <= 8
            or not all(
                isinstance(item, str) and _HEX_64.fullmatch(item)
                for item in payment.credential_ids
            )
            or len({item.lower() for item in payment.credential_ids})
            != len(payment.credential_ids)
        ):
            fail(
                "credential",
                "CREDENTIAL_IDS_INVALID",
                "decoded Payment credential ids are invalid",
            )
        if payment.destination != request.challenge.merchant_address:
            fail(
                "credential",
                "PAYMENT_DESTINATION_MISMATCH",
                "payment destination does not match",
            )
        if payment.account != authorized_payer:
            fail("credential", "PAYMENT_PAYER_MISMATCH", "payment payer is not VI-authorized")
        if wba_identity is not None and payment.account != wba_identity.subject:
            fail(
                "credential",
                "WBA_PAYER_MISMATCH",
                "Web Bot Auth subject is not the Payment payer",
            )
        for credential_id in payment.credential_ids:
            await _check_record(credential_id, payment.account, dependencies)
        return CredentialFacts("exact", payment.account, payment)

    if proof_type == "xrpl_paychan_claim":
        required = {"type", "channel_id", "cumulative_drops", "signature", "public_key"}
        if set(proof) != required or dependencies.ledger_reader is None:
            fail("credential", "PAYCHAN_PROOF_MALFORMED", "channel proof fields are invalid")
        channel_id = proof.get("channel_id")
        if not isinstance(channel_id, str) or not _HEX_64.fullmatch(channel_id):
            fail("credential", "PAYCHAN_PROOF_MALFORMED", "channel id is invalid")
        payer = await dependencies.ledger_reader.channel_source(channel_id)
        if payer != authorized_payer:
            fail("credential", "PAYMENT_PAYER_MISMATCH", "channel source is not VI-authorized")
        if wba_identity is not None and payer != wba_identity.subject:
            fail(
                "credential",
                "WBA_PAYER_MISMATCH",
                "Web Bot Auth subject is not the channel source",
            )
        record = await dependencies.ledger_reader.accepted_subject_credential(
            payer,
            dependencies.trusted_credential_issuer,
            dependencies.credential_type_hex,
        )
        if record is None:
            fail("credential", "CREDENTIAL_NOT_FOUND", "channel source has no accepted credential")
        await _check_record(record.credential_id, payer, dependencies)
        return CredentialFacts("xrpl-paychan", payer, None)

    fail("credential", "PAYMENT_SCHEME_UNSUPPORTED", "payment proof scheme is unsupported", 402)
