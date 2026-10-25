from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Protocol

import httpx
from xrpl.core.addresscodec import is_valid_classic_address
from xrpl.core.binarycodec import decode, encode_for_signing
from xrpl.core.keypairs import is_valid_message

from .approval import (
    ApprovalEnvelopeError,
    extract_issued_approval_envelope,
    validate_issued_envelope_transaction,
)
from .assets import (
    IssuedCurrencyAsset,
    NativeXrpAsset,
    exact_decimal_equal,
    parse_requirement_asset,
)

from .config import T54_TESTNET_FACILITATOR_URL, XRPL_TESTNET_JSON_RPC_URL
from .protocol import ProtocolError, decode_bounded_json_bytes


HASH_PATTERN = re.compile(r"^[A-F0-9]{64}$")
POSITIVE_DROPS = re.compile(r"^[1-9][0-9]*$")
TF_PARTIAL_PAYMENT = 0x00020000
TF_FULLY_CANONICAL_SIG = 0x80000000
TRANSACTION_HASH_PREFIX = bytes.fromhex("54584E00")
MAX_FACILITATOR_RESPONSE_BYTES = 16 * 1024
MAX_TX_SEARCH_LEDGER_COUNT = 1_000
ALLOWED_TRANSACTION_FIELDS = {
    "TransactionType",
    "Account",
    "Destination",
    "Amount",
    "DeliverMax",
    "SendMax",
    "InvoiceID",
    "SourceTag",
    "DestinationTag",
    "Fee",
    "Sequence",
    "LastLedgerSequence",
    "SigningPubKey",
    "TxnSignature",
    "Flags",
}


class VerificationError(RuntimeError):
    pass


class VerificationRejected(VerificationError):
    pass


class SettlementNotAttempted(VerificationRejected):
    """A definitive local rejection that occurred before any submission."""

    pass


@dataclass(frozen=True)
class VerificationReceipt:
    is_valid: bool
    transaction: str
    network: str
    payer: str
    pay_to: str
    amount_drops: str
    fee_drops: str
    invoice_id: str
    resource_url: str
    source_tag: int
    last_ledger_sequence: int = 0
    asset: str = "XRP"
    issuer: Optional[str] = None
    evidence_source: str = "validated-ledger"
    payer_xrp_balance_drops: Optional[str] = None
    approval_digest: Optional[str] = None


@dataclass(frozen=True)
class ReconciliationResult:
    status: str
    validated_ledger_index: Optional[int] = None

    def __post_init__(self) -> None:
        if self.status not in {"validated", "pending", "not_included"}:
            raise ValueError("invalid reconciliation status")
        if self.status == "pending" and self.validated_ledger_index is not None:
            raise ValueError("pending reconciliation cannot carry a ledger index")
        if self.status != "pending" and (
            not isinstance(self.validated_ledger_index, int)
            or self.validated_ledger_index <= 0
        ):
            raise ValueError("terminal reconciliation requires a ledger index")


class PaymentFacilitator(Protocol):
    async def current_validated_ledger(self) -> int:
        ...

    async def verify(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        ...

    async def reconcile(
        self,
        receipt: VerificationReceipt,
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
        max_fee_drops: str,
        first_ledger_sequence: Optional[int],
    ) -> ReconciliationResult:
        ...

    async def settle(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        ...


def _inspect_transaction(
    signed_blob: str,
    requirement: Mapping[str, Any],
    approval_envelope: Optional[Mapping[str, Any]] = None,
    resource: Optional[Mapping[str, Any]] = None,
) -> VerificationReceipt:
    try:
        transaction = decode(signed_blob)
    except Exception as exc:
        raise VerificationRejected("invalid_signed_tx_blob") from exc
    if not isinstance(transaction, dict) or transaction.get("TransactionType") != "Payment":
        raise VerificationRejected("not_payment_tx")

    extra = requirement["extra"]
    assert isinstance(extra, dict)
    invoice_id = extra["invoiceId"]
    source_tag = extra["sourceTag"]
    payment_asset = parse_requirement_asset(requirement)
    amount = transaction.get("DeliverMax", transaction.get("Amount"))
    if "DeliverMax" in transaction and "Amount" in transaction:
        raise VerificationRejected("ambiguous_amount")
    if isinstance(payment_asset, NativeXrpAsset):
        if amount != requirement["amount"] or not isinstance(amount, str):
            raise VerificationRejected("amount_mismatch")
        if "SendMax" in transaction:
            raise VerificationRejected("send_max_for_xrp_forbidden")
    else:
        if not isinstance(amount, dict) or set(amount) != {"currency", "issuer", "value"}:
            raise VerificationRejected("invalid_issued_amount")
        if (
            amount.get("currency") != payment_asset.currency
            or amount.get("issuer") != payment_asset.issuer
            or not isinstance(amount.get("value"), str)
            or not exact_decimal_equal(amount["value"], requirement["amount"])
        ):
            raise VerificationRejected("issued_amount_mismatch")
        send_max = transaction.get("SendMax")
        if not isinstance(send_max, dict) or set(send_max) != {
            "currency", "issuer", "value"
        }:
            raise VerificationRejected("issued_send_max_required")
        if (
            send_max.get("currency") != payment_asset.currency
            or send_max.get("issuer") != payment_asset.issuer
            or not isinstance(send_max.get("value"), str)
            or not exact_decimal_equal(send_max["value"], amount["value"])
        ):
            raise VerificationRejected("issued_send_max_mismatch")
    if transaction.get("Destination") != requirement["payTo"]:
        raise VerificationRejected("destination_mismatch")
    if transaction.get("SourceTag") != source_tag:
        raise VerificationRejected("source_tag_mismatch")
    if "destinationTag" in extra and transaction.get("DestinationTag") != extra["destinationTag"]:
        raise VerificationRejected("destination_tag_mismatch")
    if "destinationTag" not in extra and "DestinationTag" in transaction:
        raise VerificationRejected("unexpected_destination_tag")
    approval_digest: Optional[str] = None
    if isinstance(payment_asset, IssuedCurrencyAsset):
        if approval_envelope is None:
            raise VerificationRejected("semantic_approval_envelope_required")
        if resource is None:
            raise VerificationRejected("semantic_approval_resource_required")
        try:
            approval_digest = validate_issued_envelope_transaction(
                approval_envelope, transaction, requirement, resource
            )
        except ApprovalEnvelopeError as exc:
            raise VerificationRejected(exc.code) from exc
    else:
        if approval_envelope is not None:
            raise VerificationRejected("mixed_approval_contract_rejected")
        if transaction.get("InvoiceID", "").upper() != hashlib.sha256(
            invoice_id.encode("utf-8")
        ).hexdigest().upper():
            raise VerificationRejected("invoice_binding_mismatch")
    if (
        not isinstance(transaction.get("LastLedgerSequence"), int)
        or transaction["LastLedgerSequence"] <= 0
    ):
        raise VerificationRejected("missing_last_ledger_sequence")
    if transaction.get("NetworkID") is not None:
        raise VerificationRejected("invalid_testnet_network_id")
    if set(transaction) - ALLOWED_TRANSACTION_FIELDS:
        raise VerificationRejected("unsupported_payment_field")
    flags = transaction.get("Flags", 0)
    if not isinstance(flags, int) or flags & TF_PARTIAL_PAYMENT:
        raise VerificationRejected("partial_payment_forbidden")
    if flags & ~TF_FULLY_CANONICAL_SIG:
        raise VerificationRejected("unsupported_payment_flag")
    fee = transaction.get("Fee")
    payer = transaction.get("Account")
    if not isinstance(fee, str) or not POSITIVE_DROPS.fullmatch(fee):
        raise VerificationRejected("invalid_fee")
    if not isinstance(payer, str) or not is_valid_classic_address(payer):
        raise VerificationRejected("invalid_payer")
    if not isinstance(transaction.get("Sequence"), int) or transaction["Sequence"] <= 0:
        raise VerificationRejected("invalid_sequence")
    if not isinstance(transaction.get("SigningPubKey"), str) or not transaction["SigningPubKey"]:
        raise VerificationRejected("missing_signing_public_key")
    if not isinstance(transaction.get("TxnSignature"), str) or not transaction["TxnSignature"]:
        raise VerificationRejected("missing_transaction_signature")
    try:
        signing_transaction = dict(transaction)
        signature = bytes.fromhex(signing_transaction.pop("TxnSignature"))
        signing_bytes = bytes.fromhex(encode_for_signing(signing_transaction))
        if not is_valid_message(signing_bytes, signature, transaction["SigningPubKey"]):
            raise VerificationRejected("invalid_transaction_signature")
    except VerificationRejected:
        raise
    except Exception as exc:
        raise VerificationRejected("invalid_transaction_signature") from exc

    transaction_hash = (
        hashlib.sha512(TRANSACTION_HASH_PREFIX + bytes.fromhex(signed_blob))
        .digest()[:32]
        .hex()
        .upper()
    )
    return VerificationReceipt(
        is_valid=True,
        transaction=transaction_hash,
        network="xrpl:1",
        payer=payer,
        pay_to=requirement["payTo"],
        amount_drops=requirement["amount"],
        fee_drops=fee,
        invoice_id=invoice_id,
        resource_url="",
        source_tag=source_tag,
        last_ledger_sequence=transaction["LastLedgerSequence"],
        asset=requirement["asset"],
        issuer=(payment_asset.issuer if isinstance(payment_asset, IssuedCurrencyAsset) else None),
        approval_digest=approval_digest,
    )


def _approval_envelope_for_payment(
    payment_payload: Mapping[str, Any],
    payment_requirement: Mapping[str, Any],
) -> Optional[Mapping[str, Any]]:
    payment_asset = parse_requirement_asset(payment_requirement)
    if isinstance(payment_asset, IssuedCurrencyAsset):
        try:
            return extract_issued_approval_envelope(payment_payload)
        except ApprovalEnvelopeError as exc:
            raise VerificationRejected(exc.code) from exc
    if "extensions" in payment_payload:
        raise VerificationRejected("mixed_approval_contract_rejected")
    return None


class T54Facilitator:
    """Use only T54 Testnet's fixed verify and settlement endpoints."""

    def __init__(
        self,
        facilitator_url: str = T54_TESTNET_FACILITATOR_URL,
        *,
        xrpl_json_rpc_url: str = XRPL_TESTNET_JSON_RPC_URL,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        ledger_transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        if facilitator_url.rstrip("/") != T54_TESTNET_FACILITATOR_URL:
            raise ValueError("only the fixed T54 XRPL Testnet facilitator is permitted")
        self._base_url = T54_TESTNET_FACILITATOR_URL
        self._transport = transport
        if xrpl_json_rpc_url != XRPL_TESTNET_JSON_RPC_URL:
            raise ValueError("only the fixed official XRPL Testnet endpoint is permitted")
        self._ledger_url = XRPL_TESTNET_JSON_RPC_URL
        self._ledger_transport = ledger_transport

    async def _post_bounded(self, path: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        try:
            async with httpx.AsyncClient(
                timeout=5.0,
                follow_redirects=False,
                headers={"accept": "application/json", "content-type": "application/json"},
                transport=self._transport,
            ) as client:
                async with client.stream(
                    "POST", f"{self._base_url}{path}", json=payload
                ) as response:
                    if response.is_redirect:
                        raise VerificationError("facilitator_redirect_rejected")
                    if response.status_code != 200:
                        raise VerificationError(
                            f"facilitator_{path.removeprefix('/')}_http_{response.status_code}"
                        )
                    content_length = response.headers.get("content-length")
                    if content_length is not None:
                        try:
                            if int(content_length) > MAX_FACILITATOR_RESPONSE_BYTES:
                                raise VerificationError("facilitator_response_too_large")
                        except ValueError as exc:
                            raise VerificationError("invalid_facilitator_response") from exc
                    chunks = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_FACILITATOR_RESPONSE_BYTES:
                            raise VerificationError("facilitator_response_too_large")
                        chunks.append(chunk)
        except httpx.RequestError as exc:
            raise VerificationError("facilitator_unavailable") from exc
        try:
            result = decode_bounded_json_bytes(
                b"".join(chunks),
                byte_limit=MAX_FACILITATOR_RESPONSE_BYTES,
                require_object=True,
                invalid_code="invalid_facilitator_response",
                too_large_code="facilitator_response_too_large",
                complexity_code="invalid_facilitator_response",
                string_too_large_code="invalid_facilitator_response",
                key_too_large_code="invalid_facilitator_response",
                object_required_code="invalid_facilitator_response",
            )
        except ProtocolError as exc:
            raise VerificationError(exc.code) from exc
        if not isinstance(result, dict):
            raise VerificationError("invalid_facilitator_response")
        return result

    async def _ledger_tx(
        self,
        transaction_hash: str,
        *,
        min_ledger: Optional[int] = None,
        max_ledger: Optional[int] = None,
    ) -> Mapping[str, Any]:
        if (min_ledger is None) != (max_ledger is None):
            raise VerificationError("invalid_ledger_search_range")
        if min_ledger is not None and max_ledger is not None:
            ledger_count = max_ledger - min_ledger + 1
            if min_ledger <= 0 or not 1 <= ledger_count <= MAX_TX_SEARCH_LEDGER_COUNT:
                raise VerificationError("invalid_ledger_search_range")
        parameters = {
            "transaction": transaction_hash,
            "binary": False,
            "api_version": 2,
        }
        if min_ledger is not None and max_ledger is not None:
            parameters["min_ledger"] = min_ledger
            parameters["max_ledger"] = max_ledger
        payload = {
            "method": "tx",
            "params": [parameters],
        }
        try:
            async with httpx.AsyncClient(
                timeout=5.0,
                follow_redirects=False,
                headers={"accept": "application/json", "content-type": "application/json"},
                transport=self._ledger_transport,
            ) as client:
                async with client.stream("POST", self._ledger_url, json=payload) as response:
                    if response.is_redirect:
                        raise VerificationError("ledger_redirect_rejected")
                    if response.status_code != 200:
                        raise VerificationError(f"ledger_http_{response.status_code}")
                    chunks = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_FACILITATOR_RESPONSE_BYTES:
                            raise VerificationError("ledger_response_too_large")
                        chunks.append(chunk)
        except httpx.RequestError as exc:
            raise VerificationError("ledger_unavailable") from exc
        try:
            parsed = decode_bounded_json_bytes(
                b"".join(chunks),
                byte_limit=MAX_FACILITATOR_RESPONSE_BYTES,
                require_object=True,
                invalid_code="invalid_ledger_response",
                too_large_code="ledger_response_too_large",
                complexity_code="invalid_ledger_response",
                string_too_large_code="invalid_ledger_response",
                key_too_large_code="invalid_ledger_response",
                object_required_code="invalid_ledger_response",
            )
        except ProtocolError as exc:
            raise VerificationError(exc.code) from exc
        assert isinstance(parsed, dict)
        return parsed

    async def _validated_ledger_index(self) -> int:
        payload = {
            "method": "ledger",
            "params": [{"ledger_index": "validated", "transactions": False}],
        }
        try:
            async with httpx.AsyncClient(
                timeout=5.0,
                follow_redirects=False,
                headers={"accept": "application/json", "content-type": "application/json"},
                transport=self._ledger_transport,
            ) as client:
                async with client.stream("POST", self._ledger_url, json=payload) as response:
                    if response.is_redirect:
                        raise VerificationError("ledger_redirect_rejected")
                    if response.status_code != 200:
                        raise VerificationError(f"ledger_http_{response.status_code}")
                    chunks = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_FACILITATOR_RESPONSE_BYTES:
                            raise VerificationError("ledger_response_too_large")
                        chunks.append(chunk)
        except httpx.RequestError as exc:
            raise VerificationError("ledger_unavailable") from exc
        try:
            parsed = decode_bounded_json_bytes(
                b"".join(chunks),
                byte_limit=MAX_FACILITATOR_RESPONSE_BYTES,
                require_object=True,
                invalid_code="invalid_ledger_response",
                too_large_code="ledger_response_too_large",
                complexity_code="invalid_ledger_response",
                string_too_large_code="invalid_ledger_response",
                key_too_large_code="invalid_ledger_response",
                object_required_code="invalid_ledger_response",
            )
        except ProtocolError as exc:
            raise VerificationError(exc.code) from exc
        result = parsed.get("result") if isinstance(parsed, dict) else None
        if not isinstance(result, dict) or result.get("validated") is not True:
            raise VerificationError("invalid_ledger_response")
        ledger_index = result.get("ledger_index")
        if not isinstance(ledger_index, int) or ledger_index <= 0:
            raise VerificationError("invalid_ledger_response")
        return ledger_index

    async def current_validated_ledger(self) -> int:
        return await self._validated_ledger_index()

    @staticmethod
    def _request(
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        return {
            "paymentPayload": payment_payload,
            "paymentRequirements": payment_requirement,
        }

    async def verify(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        signed_blob = payment_payload["payload"]["signedTxBlob"]
        inspected = _inspect_transaction(
            signed_blob,
            payment_requirement,
            _approval_envelope_for_payment(payment_payload, payment_requirement),
            resource,
        )
        result = await self._post_bounded(
            "/verify", self._request(payment_payload, payment_requirement)
        )
        if not isinstance(result, dict) or type(result.get("isValid")) is not bool:
            raise VerificationError("invalid_facilitator_response")
        if result["isValid"] is not True:
            raise VerificationRejected("facilitator_rejected_payment")
        if result.get("payer") != inspected.payer:
            raise VerificationRejected("facilitator_payer_mismatch")
        return VerificationReceipt(
            **{
                **inspected.__dict__,
                "resource_url": resource["url"],
            }
        )

    async def settle(
        self,
        payment_payload: Mapping[str, Any],
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
    ) -> VerificationReceipt:
        signed_blob = payment_payload["payload"]["signedTxBlob"]
        inspected = _inspect_transaction(
            signed_blob,
            payment_requirement,
            _approval_envelope_for_payment(payment_payload, payment_requirement),
            resource,
        )
        result = await self._post_bounded(
            "/settle", self._request(payment_payload, payment_requirement)
        )
        if type(result.get("success")) is not bool:
            raise VerificationError("invalid_facilitator_response")
        if result["success"] is not True:
            raise VerificationRejected("facilitator_settlement_failed")
        if (
            result.get("transaction") != inspected.transaction
            or result.get("network") != "xrpl:1"
            or result.get("payer") != inspected.payer
        ):
            raise VerificationRejected("facilitator_settlement_mismatch")
        return VerificationReceipt(
            **{
                **inspected.__dict__,
                "resource_url": resource["url"],
            }
        )

    async def reconcile(
        self,
        receipt: VerificationReceipt,
        payment_requirement: Mapping[str, Any],
        resource: Mapping[str, Any],
        max_fee_drops: str,
        first_ledger_sequence: Optional[int],
    ) -> ReconciliationResult:
        legacy_presence_only = (
            receipt.last_ledger_sequence == 0 and first_ledger_sequence is None
        )
        validate_receipt(
            receipt,
            requirement=payment_requirement,
            resource=resource,
            max_fee_drops=max_fee_drops,
            first_ledger_sequence=first_ledger_sequence,
            allow_legacy_missing_last_ledger_sequence=legacy_presence_only,
        )

        # An unbounded hash lookup can recover a validated payment immediately,
        # including legacy receipts that predate persisted ledger-window bounds.
        response = await self._ledger_tx(receipt.transaction)
        result = response.get("result")
        if not isinstance(result, dict):
            raise VerificationError("invalid_ledger_response")
        not_found = result.get("error") in {"txnNotFound", "transactionNotFound"}
        if not not_found:
            if result.get("validated") is not True:
                return ReconciliationResult("pending")
            return self._validate_ledger_payment(
                result,
                receipt,
                payment_requirement,
                max_fee_drops,
                legacy_presence_only=legacy_presence_only,
                first_ledger_sequence=first_ledger_sequence,
            )

        # Missing legacy bounds can never prove absence. For current invoices,
        # close the persisted post-issuance window and then search it explicitly.
        if legacy_presence_only or first_ledger_sequence is None:
            return ReconciliationResult("pending")
        validated_ledger_index = await self._validated_ledger_index()
        if validated_ledger_index <= receipt.last_ledger_sequence:
            return ReconciliationResult("pending")
        response = await self._ledger_tx(
            receipt.transaction,
            min_ledger=first_ledger_sequence,
            max_ledger=receipt.last_ledger_sequence,
        )
        result = response.get("result")
        if not isinstance(result, dict):
            raise VerificationError("invalid_ledger_response")
        if result.get("error") in {"txnNotFound", "transactionNotFound"}:
            if result.get("searched_all") is not True:
                return ReconciliationResult("pending")
            return ReconciliationResult("not_included", validated_ledger_index)
        if result.get("validated") is not True:
            return ReconciliationResult("pending")
        return self._validate_ledger_payment(
            result,
            receipt,
            payment_requirement,
            max_fee_drops,
            legacy_presence_only=False,
            first_ledger_sequence=first_ledger_sequence,
        )

    @staticmethod
    def _validate_ledger_payment(
        result: Mapping[str, Any],
        receipt: VerificationReceipt,
        payment_requirement: Mapping[str, Any],
        max_fee_drops: str,
        *,
        legacy_presence_only: bool,
        first_ledger_sequence: Optional[int],
    ) -> ReconciliationResult:
        meta = result.get("meta")
        transaction = result.get("tx_json")
        if not isinstance(meta, dict) or not isinstance(transaction, dict):
            raise VerificationRejected("invalid_validated_ledger_result")
        if meta.get("TransactionResult") != "tesSUCCESS":
            raise VerificationRejected("ledger_transaction_failed")
        payment_asset = parse_requirement_asset(payment_requirement)
        delivered = meta.get("delivered_amount", meta.get("DeliveredAmount"))
        if isinstance(payment_asset, NativeXrpAsset):
            if delivered != payment_requirement["amount"] or not isinstance(delivered, str):
                raise VerificationRejected("ledger_delivered_amount_mismatch")
        elif (
            not isinstance(delivered, dict)
            or set(delivered) != {"currency", "issuer", "value"}
            or delivered.get("currency") != payment_asset.currency
            or delivered.get("issuer") != payment_asset.issuer
            or not isinstance(delivered.get("value"), str)
            or not exact_decimal_equal(delivered["value"], payment_requirement["amount"])
        ):
            raise VerificationRejected("ledger_delivered_amount_mismatch")
        if result.get("hash", transaction.get("hash")) != receipt.transaction:
            raise VerificationRejected("ledger_transaction_hash_mismatch")
        ledger_index = result.get("ledger_index")
        transaction_last_ledger = transaction.get("LastLedgerSequence")
        if (
            not isinstance(ledger_index, int)
            or ledger_index <= 0
            or not isinstance(transaction_last_ledger, int)
            or transaction_last_ledger <= 0
            or ledger_index > transaction_last_ledger
            or (
                first_ledger_sequence is not None
                and ledger_index < first_ledger_sequence
            )
        ):
            raise VerificationRejected("ledger_index_mismatch")
        if transaction.get("TransactionType") != "Payment":
            raise VerificationRejected("ledger_transaction_type_mismatch")
        if transaction.get("Account") != receipt.payer:
            raise VerificationRejected("ledger_payer_mismatch")
        if transaction.get("Destination") != payment_requirement["payTo"]:
            raise VerificationRejected("ledger_destination_mismatch")
        amount = transaction.get("DeliverMax", transaction.get("Amount"))
        if "DeliverMax" in transaction and "Amount" in transaction:
            raise VerificationRejected("ledger_ambiguous_amount")
        if isinstance(payment_asset, NativeXrpAsset):
            if amount != payment_requirement["amount"] or not isinstance(amount, str):
                raise VerificationRejected("ledger_amount_mismatch")
        elif (
            not isinstance(amount, dict)
            or set(amount) != {"currency", "issuer", "value"}
            or amount.get("currency") != payment_asset.currency
            or amount.get("issuer") != payment_asset.issuer
            or not isinstance(amount.get("value"), str)
            or not exact_decimal_equal(amount["value"], payment_requirement["amount"])
        ):
            raise VerificationRejected("ledger_amount_mismatch")
        extra = payment_requirement["extra"]
        if transaction.get("SourceTag") != extra["sourceTag"]:
            raise VerificationRejected("ledger_source_tag_mismatch")
        if (
            not legacy_presence_only
            and transaction_last_ledger != receipt.last_ledger_sequence
        ):
            raise VerificationRejected("ledger_last_ledger_sequence_mismatch")
        if "destinationTag" in extra:
            if transaction.get("DestinationTag") != extra["destinationTag"]:
                raise VerificationRejected("ledger_destination_tag_mismatch")
        elif "DestinationTag" in transaction:
            raise VerificationRejected("ledger_unexpected_destination_tag")
        if isinstance(payment_asset, IssuedCurrencyAsset):
            expected_invoice = receipt.approval_digest
            if (
                not isinstance(expected_invoice, str)
                or not HASH_PATTERN.fullmatch(expected_invoice)
            ):
                raise VerificationRejected("ledger_approval_digest_missing")
        else:
            expected_invoice = hashlib.sha256(
                extra["invoiceId"].encode("utf-8")
            ).hexdigest().upper()
        if transaction.get("InvoiceID", "").upper() != expected_invoice:
            raise VerificationRejected("ledger_invoice_binding_mismatch")
        fee = transaction.get("Fee")
        if (
            not isinstance(fee, str)
            or not POSITIVE_DROPS.fullmatch(fee)
            or fee != receipt.fee_drops
            or int(fee) > int(max_fee_drops)
        ):
            raise VerificationRejected("ledger_fee_mismatch")
        flags = transaction.get("Flags", 0)
        if not isinstance(flags, int) or flags & TF_PARTIAL_PAYMENT:
            raise VerificationRejected("ledger_partial_payment_forbidden")
        if flags & ~TF_FULLY_CANONICAL_SIG:
            raise VerificationRejected("ledger_unsupported_payment_flag")
        forbidden = ("Memos", "Paths", "DeliverMin", "Delegate")
        if any(key in transaction for key in forbidden):
            raise VerificationRejected("ledger_unsupported_payment_field")
        if isinstance(payment_asset, NativeXrpAsset) and "SendMax" in transaction:
            raise VerificationRejected("ledger_unsupported_payment_field")
        if isinstance(payment_asset, IssuedCurrencyAsset):
            send_max = transaction.get("SendMax")
            if (
                not isinstance(send_max, dict)
                or set(send_max) != {"currency", "issuer", "value"}
                or send_max.get("currency") != payment_asset.currency
                or send_max.get("issuer") != payment_asset.issuer
                or not isinstance(send_max.get("value"), str)
                or not exact_decimal_equal(send_max["value"], payment_requirement["amount"])
            ):
                raise VerificationRejected("ledger_send_max_mismatch")
        return ReconciliationResult("validated", ledger_index)


def validate_receipt(
    receipt: VerificationReceipt,
    *,
    requirement: Mapping[str, Any],
    resource: Mapping[str, Any],
    max_fee_drops: str,
    first_ledger_sequence: Optional[int] = None,
    allow_legacy_missing_last_ledger_sequence: bool = False,
) -> None:
    extra = requirement["extra"]
    last_ledger_is_valid = (
        isinstance(receipt.last_ledger_sequence, int)
        and receipt.last_ledger_sequence > 0
    ) or (
        allow_legacy_missing_last_ledger_sequence
        and receipt.last_ledger_sequence == 0
        and first_ledger_sequence is None
    )
    payment_asset = parse_requirement_asset(requirement)
    timeout = requirement.get("maxTimeoutSeconds")
    max_ledger_delta = (
        math.ceil(timeout / 5) + 2
        if isinstance(timeout, int) and not isinstance(timeout, bool) and timeout > 0
        else 0
    )
    effective_window = (
        min(MAX_TX_SEARCH_LEDGER_COUNT, max_ledger_delta)
        if isinstance(payment_asset, IssuedCurrencyAsset)
        else MAX_TX_SEARCH_LEDGER_COUNT
    )
    ledger_window_is_valid = first_ledger_sequence is None or (
        isinstance(first_ledger_sequence, int)
        and first_ledger_sequence > 0
        and receipt.last_ledger_sequence >= first_ledger_sequence
        and receipt.last_ledger_sequence - first_ledger_sequence + 1
        <= effective_window
    )
    expected_issuer = (
        payment_asset.issuer if isinstance(payment_asset, IssuedCurrencyAsset) else None
    )
    approval_digest_is_valid = (
        (
            isinstance(receipt.approval_digest, str)
            and HASH_PATTERN.fullmatch(receipt.approval_digest) is not None
        )
        if isinstance(payment_asset, IssuedCurrencyAsset)
        else receipt.approval_digest is None
    )
    if (
        receipt.is_valid is not True
        or not HASH_PATTERN.fullmatch(receipt.transaction)
        or receipt.network != "xrpl:1"
        or not is_valid_classic_address(receipt.payer)
        or receipt.pay_to != requirement["payTo"]
        or not exact_decimal_equal(receipt.amount_drops, requirement["amount"])
        or receipt.asset != requirement["asset"]
        or receipt.issuer != expected_issuer
        or not approval_digest_is_valid
        or receipt.invoice_id != extra["invoiceId"]
        or receipt.resource_url != resource["url"]
        or receipt.source_tag != extra["sourceTag"]
        or not last_ledger_is_valid
        or not ledger_window_is_valid
        or not POSITIVE_DROPS.fullmatch(receipt.fee_drops)
        or int(receipt.fee_drops) > int(max_fee_drops)
    ):
        raise VerificationRejected("receipt_binding_mismatch")
