"""Settlement checks, with live execution locked behind an explicit Testnet gate."""

import hashlib
import re
from dataclasses import replace
from collections.abc import Mapping

from .context import MerchantValidationRequest, PaymentResult, ValidatorDependencies
from .credential import CredentialFacts
from .errors import ValidationFailure, fail
from .intent import money


_UINT = re.compile(r"^(0|[1-9][0-9]*)$")
_HEX_64 = re.compile(r"^[A-Fa-f0-9]{64}$")
_TF_PARTIAL_PAYMENT = 0x00020000
_TF_FULLY_CANONICAL_SIG = 0x80000000
_PAYCHAN_PUBLIC_KEY = re.compile(r"^(?:(?:02|03)|ED)[A-Fa-f0-9]{64}$")
_PAYCHAN_SIGNATURE = re.compile(r"^[A-Fa-f0-9]+$")
_UINT64_MAX = (1 << 64) - 1
_UINT64_MAX_TEXT = str(_UINT64_MAX)


def _integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _uint64_text(value: object) -> bool:
    return (
        isinstance(value, str)
        and _UINT.fullmatch(value) is not None
        and value != "0"
        and len(value) <= len(_UINT64_MAX_TEXT)
        and (len(value) < len(_UINT64_MAX_TEXT) or value <= _UINT64_MAX_TEXT)
    )


def _paychan_proof(value: object) -> dict[str, object]:
    """Parse and normalize the exact five-field claim proof once."""

    required = {
        "type",
        "channel_id",
        "cumulative_drops",
        "signature",
        "public_key",
    }
    if not isinstance(value, Mapping) or set(value) != required:
        fail("payment", "PAYCHAN_PROOF_MALFORMED", "channel proof fields are invalid")
    channel_id = value.get("channel_id")
    cumulative_drops = value.get("cumulative_drops")
    signature = value.get("signature")
    public_key = value.get("public_key")
    if (
        value.get("type") != "xrpl_paychan_claim"
        or not isinstance(channel_id, str)
        or not _HEX_64.fullmatch(channel_id)
        or not _uint64_text(cumulative_drops)
        or not isinstance(signature, str)
        or not signature
        or len(signature) % 2 != 0
        or len(signature) > 144
        or not _PAYCHAN_SIGNATURE.fullmatch(signature)
        or not isinstance(public_key, str)
        or not _PAYCHAN_PUBLIC_KEY.fullmatch(public_key)
        or (public_key.upper().startswith("ED") and len(signature) != 128)
    ):
        fail("payment", "PAYCHAN_PROOF_MALFORMED", "channel proof is invalid")
    return {
        "type": "xrpl_paychan_claim",
        "channel_id": channel_id.upper(),
        "cumulative_drops": cumulative_drops,
        "signature": signature.upper(),
        "public_key": public_key.upper(),
    }


async def _verify_paychan(
    request: MerchantValidationRequest,
    credential: CredentialFacts,
    dependencies: ValidatorDependencies,
) -> PaymentResult:
    if dependencies.payment_mode not in ("mock", "live"):
        fail("payment", "PAYMENT_MODE_INVALID", "payment mode is not recognized", 503)
    if dependencies.payment_mode == "live" and dependencies.allow_live is not True:
        fail("payment", "LIVE_GATE_CLOSED", "live settlement gate is closed", 503)
    if request.network != "testnet":
        fail("payment", "NETWORK_NOT_TESTNET", "only XRPL Testnet is allowed")
    verifier = dependencies.paychan_verifier
    if verifier is None:
        fail(
            "payment",
            "PAYCHAN_PENDING_MM3",
            "payment-channel settlement is not installed",
            402,
        )

    expected_increment = request.challenge.paychan_claim_drops
    if (
        not _uint64_text(expected_increment)
    ):
        fail(
            "payment",
            "PAYCHAN_PRICE_INVALID",
            "trusted channel price is invalid",
            500,
        )

    proof = _paychan_proof(request.payment_proof)
    normalized_request = replace(request, payment_proof=proof)
    try:
        retry_key = verifier.retry_key(proof)
        result = await verifier.validate_claim(
            normalized_request,
            credentialed_payer=credential.payer,
        )
    except ValidationFailure:
        raise
    except Exception as exc:
        error_status = getattr(exc, "http_status", 402)
        if (
            not isinstance(error_status, int)
            or isinstance(error_status, bool)
            or not 400 <= error_status <= 599
        ):
            error_status = 402
        fail(
            "payment",
            "PAYCHAN_CLAIM_REJECTED",
            "payment-channel claim was rejected",
            error_status,
        )

    if (
        not isinstance(retry_key, str)
        or not _HEX_64.fullmatch(retry_key)
        or not isinstance(result, PaymentResult)
        or not isinstance(result.tx_hash, str)
        or not _HEX_64.fullmatch(result.tx_hash)
        or result.tx_hash.upper() != retry_key.upper()
        or result.validated is not True
        or result.engine_result not in ("claim_accepted", "claim_replay")
        or result.delivered_currency != "XRP"
        or result.delivered_issuer is not None
        or result.delivered_value != expected_increment
    ):
        fail(
            "payment",
            "PAYCHAN_RESULT_INVALID",
            "payment-channel claim result is invalid",
            502,
        )
    return result


async def verify_payment(
    request: MerchantValidationRequest,
    credential: CredentialFacts,
    dependencies: ValidatorDependencies,
) -> PaymentResult:
    if credential.scheme == "xrpl-paychan":
        return await _verify_paychan(request, credential, dependencies)
    if credential.payment is None:
        fail("payment", "PAYMENT_MISSING", "decoded payment is unavailable", 402)
    payment = credential.payment
    challenge = request.challenge
    settlement = challenge.settlement
    if (
        not isinstance(challenge.state_id, str)
        or not challenge.state_id
        or len(challenge.state_id) > 128
        or not isinstance(challenge.invoice_id, str)
        or not challenge.invoice_id
        or len(challenge.invoice_id.encode("utf-8")) > 200
        or not isinstance(challenge.l3a_digest, str)
        or not _HEX_64.fullmatch(challenge.l3a_digest)
        or not _integer(challenge.network_id)
        or challenge.network_id < 0
        or not all(
            _integer(value) and 0 <= value <= 0xFFFFFFFF
            for value in (challenge.source_tag,)
        )
        or (
            challenge.destination_tag is not None
            and (
                not _integer(challenge.destination_tag)
                or not 0 <= challenge.destination_tag <= 0xFFFFFFFF
            )
        )
        or not _integer(challenge.current_ledger_index)
        or challenge.current_ledger_index < 0
        or not _integer(challenge.max_last_ledger_delta)
        or challenge.max_last_ledger_delta <= 0
        or not _integer(challenge.max_fee_drops)
        or challenge.max_fee_drops <= 0
        or not _integer(challenge.allowed_payment_flags)
        or challenge.allowed_payment_flags != _TF_FULLY_CANONICAL_SIG
    ):
        fail("payment", "CHALLENGE_STATE_INVALID", "server challenge state is invalid", 500)
    if payment.transaction_type != "Payment":
        fail("payment", "PAYMENT_TYPE_MISMATCH", "transaction is not a Payment")
    if not isinstance(payment.unknown_fields, tuple) or payment.unknown_fields != ():
        fail("payment", "PAYMENT_FIELDS_INVALID", "decoded Payment contains unknown fields")
    if (
        not _integer(payment.flags)
        or payment.flags & _TF_PARTIAL_PAYMENT
        or payment.flags not in (0, _TF_FULLY_CANONICAL_SIG)
    ):
        fail("payment", "PAYMENT_FLAGS_INVALID", "Payment flags are not allowed")
    if payment.network_id is not None and (
        not _integer(payment.network_id) or payment.network_id != challenge.network_id
    ):
        fail("payment", "PAYMENT_NETWORK_MISMATCH", "Payment NetworkID does not match")
    if payment.currency != settlement.code:
        fail("payment", "PAYMENT_CURRENCY_MISMATCH", "payment currency does not match")
    if payment.issuer != settlement.issuer:
        fail("payment", "PAYMENT_ISSUER_MISMATCH", "payment issuer does not match")
    if not _integer(payment.source_tag) or payment.source_tag != challenge.source_tag:
        fail("payment", "PAYMENT_SOURCE_TAG_MISMATCH", "SourceTag does not match")
    if payment.destination_tag != challenge.destination_tag or (
        payment.destination_tag is not None and not _integer(payment.destination_tag)
    ):
        fail("payment", "PAYMENT_DESTINATION_TAG_MISMATCH", "DestinationTag does not match")
    expected_invoice = hashlib.sha256(challenge.invoice_id.encode("utf-8")).hexdigest().upper()
    if payment.invoice_id != expected_invoice:
        fail("payment", "PAYMENT_INVOICE_MISMATCH", "invoice id does not match")
    if payment.memos != (
        f"ap4m/{request.intent.get('intentId', '')}/{challenge.l3a_digest.lower()}",
    ):
        fail("payment", "PAYMENT_MEMO_MISMATCH", "payment memos do not match")
    if not isinstance(payment.tx_hash, str) or not _HEX_64.fullmatch(payment.tx_hash):
        fail("payment", "PAYMENT_HASH_INVALID", "Payment hash is invalid")
    if money(payment.value, code="PAYMENT_AMOUNT_INVALID", stage="payment") != money(
        settlement.value, code="PAYMENT_PRICE_INVALID", stage="payment"
    ):
        fail("payment", "PAYMENT_AMOUNT_MISMATCH", "payment amount is not exact", 402)
    if (
        not _integer(payment.last_ledger_sequence)
        or payment.last_ledger_sequence <= challenge.current_ledger_index
        or payment.last_ledger_sequence
        > challenge.current_ledger_index + challenge.max_last_ledger_delta
    ):
        fail(
            "payment",
            "PAYMENT_LEDGER_WINDOW_INVALID",
            "LastLedgerSequence is outside the challenge window",
        )
    if not isinstance(payment.fee_drops, str) or not _UINT.fullmatch(payment.fee_drops):
        fail("payment", "PAYMENT_FEE_INVALID", "Fee is not canonical drops")
    if int(payment.fee_drops) <= 0 or int(payment.fee_drops) > challenge.max_fee_drops:
        fail("payment", "PAYMENT_FEE_TOO_HIGH", "Fee exceeds the challenge cap")
    if dependencies.payment_mode not in ("mock", "live"):
        fail("payment", "PAYMENT_MODE_INVALID", "payment mode is not recognized", 503)
    if dependencies.payment_mode == "live" and dependencies.allow_live is not True:
        fail("payment", "LIVE_GATE_CLOSED", "live settlement gate is closed", 503)
    if request.network != "testnet":
        fail("payment", "NETWORK_NOT_TESTNET", "only XRPL Testnet is allowed")
    if dependencies.payment_transport is None:
        fail("payment", "PAYMENT_TRANSPORT_UNAVAILABLE", "payment transport unavailable", 503)

    result = await dependencies.payment_transport.validate_exact(payment, request)
    if not isinstance(result.tx_hash, str) or not _HEX_64.fullmatch(result.tx_hash):
        fail("payment", "PAYMENT_HASH_INVALID", "settlement hash is invalid")
    if result.tx_hash.lower() != payment.tx_hash.lower():
        fail("payment", "PAYMENT_HASH_MISMATCH", "settlement hash does not match")
    if result.validated is not True or result.engine_result != "tesSUCCESS":
        fail("payment", "PAYMENT_NOT_VALIDATED", "payment is not validated", 402)
    if result.delivered_currency != settlement.code:
        fail("payment", "DELIVERED_CURRENCY_MISMATCH", "delivered currency does not match")
    if result.delivered_issuer != settlement.issuer:
        fail("payment", "DELIVERED_ISSUER_MISMATCH", "delivered issuer does not match")
    if money(
        result.delivered_value, code="DELIVERED_AMOUNT_INVALID", stage="payment"
    ) != money(
        settlement.value, code="PAYMENT_PRICE_INVALID", stage="payment"
    ):
        fail("payment", "DELIVERED_AMOUNT_MISMATCH", "delivered amount is not exact", 402)
    return result
