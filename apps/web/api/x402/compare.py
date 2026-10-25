from __future__ import annotations

import hashlib
import ipaddress
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Callable, Mapping, Optional

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .assets import IssuedCurrencyAsset, NativeXrpAsset, PaymentOffer, parse_requirement_asset
from .budget import (
    BudgetConflict,
    BudgetDisabled,
    BudgetExceeded,
    InsufficientXrpReserve,
    IssuedAssetBudgetLedger,
    IssuedAssetIdentity,
)
from .config import MerchantConfig, RESOURCE_PATH, RESOURCE_URL
from .protocol import (
    ProtocolError,
    assert_bounded_json,
    build_challenge,
    decode_payment_header,
    encode_header,
    validate_payment_payload,
)
from .store import InvoiceCapacityError, InvoiceStore
from .verifier import (
    PaymentFacilitator,
    SettlementNotAttempted,
    T54Facilitator,
    VerificationError,
    VerificationRejected,
    validate_receipt,
)


RESOURCE_INFO = {
    "url": RESOURCE_URL,
    "description": "Local Pilot venue comparison",
    "mimeType": "application/json",
    "serviceName": "Pilot",
    "tags": ["compare"],
}
MERCHANT_BODY = {"comparison": ["dex", "amm"]}
LOOPBACK_HOST = "127.0.0.1:8000"
LOOPBACK_ORIGIN = "http://127.0.0.1:8000"


class MerchantService:
    def __init__(
        self,
        config: MerchantConfig,
        verifier: PaymentFacilitator,
        *,
        clock: Callable[[], float],
        invoice_id_factory: Callable[[], str],
        offer: Optional[PaymentOffer] = None,
        budget: Optional[IssuedAssetBudgetLedger] = None,
        allow_fixture_evidence: bool = False,
        merchant_id: Optional[str] = None,
        resource_info: Mapping[str, Any] = RESOURCE_INFO,
        merchant_body: Mapping[str, Any] = MERCHANT_BODY,
    ) -> None:
        self.config = config
        self.verifier = verifier
        self.clock = clock
        self.invoice_id_factory = invoice_id_factory
        self.offer = offer or PaymentOffer(NativeXrpAsset(), config.price_drops)
        self.budget = budget
        self.allow_fixture_evidence = allow_fixture_evidence
        self.merchant_id = merchant_id
        self.resource_info = dict(resource_info)
        self.merchant_body = dict(merchant_body)
        self._store: Optional[InvoiceStore] = None
        assert_bounded_json(self.resource_info, require_object=True)
        assert_bounded_json(self.merchant_body, require_object=True)

    @property
    def store(self) -> InvoiceStore:
        if self._store is None:
            raise RuntimeError("merchant service has not started")
        return self._store

    def startup(self) -> None:
        if self._store is None:
            self._store = InvoiceStore(self.config.invoice_db_path, self.clock)

    async def issue_challenge(
        self, error: str = "PAYMENT-SIGNATURE header is required"
    ) -> JSONResponse:
        try:
            first_ledger_sequence = await self.verifier.current_validated_ledger() + 1
        except VerificationError:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "challenge_ledger_unavailable",
                    "retryable": True,
                },
                headers={"Retry-After": "1"},
            )
        invoice_id = self.invoice_id_factory()
        challenge = build_challenge(
            invoice_id=invoice_id,
            resource=self.resource_info,
            pay_to=self.config.pay_to,
            amount=self.config.price_drops,
            timeout_seconds=self.config.max_timeout_seconds,
            source_tag=self.config.source_tag,
            offer=self.offer,
            error=error,
        )
        requirement = challenge["accepts"][0]
        try:
            invoice = self.store.put_or_reuse(
                invoice_id,
                challenge["resource"],
                requirement,
                self.config.max_timeout_seconds,
                first_ledger_sequence,
            )
        except InvoiceCapacityError as exc:
            return JSONResponse(
                status_code=429,
                content={
                    "error": exc.reason,
                    "retryable": False,
                    "operatorAction": (
                        "Preserve the invoice database and review retained audit "
                        "records before increasing the explicit local quota."
                    ),
                },
            )
        assert invoice is not None
        challenge = build_challenge(
            invoice_id=invoice.invoice_id,
            resource=invoice.resource,
            pay_to=invoice.requirement["payTo"],
            amount=invoice.requirement["amount"],
            timeout_seconds=invoice.requirement["maxTimeoutSeconds"],
            source_tag=invoice.requirement["extra"]["sourceTag"],
            offer=self.offer,
            error=error,
        )
        return JSONResponse(
            status_code=402,
            content=challenge,
            headers={"PAYMENT-REQUIRED": encode_header(challenge)},
        )

    async def paid_response(
        self, payment_signature: str, resource_method: str
    ) -> JSONResponse:
        try:
            payload = decode_payment_header(payment_signature)
            accepted = payload.get("accepted")
            if not isinstance(accepted, dict) or not isinstance(accepted.get("extra"), dict):
                raise ProtocolError("invalid_accepted")
            invoice_id = accepted["extra"].get("invoiceId")
            if not isinstance(invoice_id, str):
                raise ProtocolError("invalid_invoice_id")
            invoice = self.store.get(invoice_id)
            if invoice is None:
                raise ProtocolError("unknown_invoice_id", 402)
            validated_invoice_id, _, _ = validate_payment_payload(
                payload,
                invoice.resource,
                invoice.requirement,
                expected_merchant_id=self.merchant_id,
                expected_first_ledger_sequence=invoice.first_ledger_sequence,
                expected_resource_method=resource_method,
                # Freshness gates the first verification/signature claim. Once
                # settlement is durable or terminal, exact replay must remain
                # able to reconcile or return the cached result after expiry.
                approval_now=(
                    self.clock()
                    if invoice.state in {"pending", "verifying"}
                    else None
                ),
            )
            if validated_invoice_id != invoice_id:
                raise ProtocolError("invoice_binding_mismatch", 402)
            fingerprint = hashlib.sha256(payment_signature.encode("ascii")).hexdigest()
            claim = self.store.claim(invoice_id, fingerprint)
        except KeyError:
            return JSONResponse(status_code=402, content={"error": "unknown_invoice_id"})
        except ProtocolError as exc:
            return JSONResponse(status_code=exc.status_code, content={"error": exc.code})

        if claim.outcome == "cached":
            assert claim.invoice.response_body is not None
            assert claim.invoice.payment_response is not None
            return JSONResponse(
                status_code=200,
                content=claim.invoice.response_body,
                headers={"PAYMENT-RESPONSE": claim.invoice.payment_response},
            )
        if claim.outcome == "expired":
            return JSONResponse(status_code=402, content={"error": "expired_invoice"})
        if claim.outcome == "in_progress":
            return JSONResponse(
                status_code=409,
                content={"error": "payment_verification_in_progress"},
                headers={"Retry-After": "1"},
            )
        if claim.outcome == "conflict":
            return JSONResponse(status_code=409, content={"error": "invoice_replay_conflict"})
        if claim.outcome == "rejected":
            assert claim.invoice.response_body is not None
            if self.budget is not None and not self.budget.release(
                claim.invoice.invoice_id
            ):
                return JSONResponse(
                    status_code=503,
                    content={
                        "error": "budget_release_uncertain",
                        "retryable": True,
                        "phase": "settle",
                        "settlementAttempted": False,
                    },
                    headers={"Retry-After": "1"},
                )
            return JSONResponse(status_code=402, content=claim.invoice.response_body)
        if claim.outcome == "not_included":
            if self.budget is not None and not self.budget.release_not_included(
                claim.invoice.invoice_id
            ):
                return JSONResponse(
                    status_code=503,
                    content={
                        "error": "budget_release_uncertain",
                        "retryable": True,
                        "phase": "reconcile",
                        "settlementAttempted": True,
                    },
                    headers={"Retry-After": "1"},
                )
            return self._not_included_response(claim.invoice)
        if claim.outcome == "reconcile":
            return await self._reconcile(claim.invoice, fingerprint)

        try:
            receipt = await self.verifier.verify(payload, invoice.requirement, invoice.resource)
            validate_receipt(
                receipt,
                requirement=invoice.requirement,
                resource=invoice.resource,
                max_fee_drops=self.config.max_payer_fee_drops,
                first_ledger_sequence=invoice.first_ledger_sequence,
            )
            if receipt.evidence_source == "deterministic-offline-fixture" and not self.allow_fixture_evidence:
                raise VerificationRejected("fixture_evidence_not_permitted")
        except VerificationRejected as exc:
            if not self.store.release(
                invoice_id, fingerprint, claim.invoice.claim_generation
            ):
                return JSONResponse(status_code=409, content={"error": "invoice_claim_lost"})
            return JSONResponse(status_code=402, content={"error": str(exc)})
        except VerificationError:
            if not self.store.release(
                invoice_id, fingerprint, claim.invoice.claim_generation
            ):
                return JSONResponse(status_code=409, content={"error": "invoice_claim_lost"})
            return JSONResponse(
                status_code=503,
                content={
                    "error": "facilitator_verification_unavailable",
                    "retryable": True,
                    "phase": "verify",
                    "settlementAttempted": False,
                },
                headers={"Retry-After": "1"},
            )

        budget_key: Optional[str] = None
        if self.budget is not None:
            payment_asset = parse_requirement_asset(invoice.requirement)
            if not isinstance(payment_asset, IssuedCurrencyAsset):
                return JSONResponse(status_code=500, content={"error": "issued_budget_asset_mismatch"})
            if receipt.payer_xrp_balance_drops is None:
                return JSONResponse(status_code=503, content={"error": "payer_xrp_balance_unavailable", "retryable": False})
            budget_key = invoice.invoice_id
            try:
                self.budget.reserve(
                    idempotency_key=budget_key,
                    invoice_id=invoice.invoice_id,
                    payer=receipt.payer,
                    asset=IssuedAssetIdentity(
                        network=payment_asset.network,
                        currency=payment_asset.currency,
                        issuer=payment_asset.issuer,
                    ),
                    amount=invoice.requirement["amount"],
                    fee_drops=receipt.fee_drops,
                    payer_xrp_balance_drops=receipt.payer_xrp_balance_drops,
                )
            except (BudgetConflict, BudgetDisabled, BudgetExceeded, InsufficientXrpReserve) as exc:
                self.store.release(invoice_id, fingerprint, claim.invoice.claim_generation)
                return JSONResponse(status_code=402, content={"error": str(exc)})

        transition = self.store.mark_settling(
            invoice_id,
            fingerprint,
            claim.invoice.claim_generation,
            receipt,
        )
        if transition.outcome == "expired":
            if budget_key is not None:
                self.budget.release(budget_key)
            return JSONResponse(status_code=402, content={"error": "expired_invoice"})
        if transition.outcome != "settling":
            if budget_key is not None:
                self.budget.release(budget_key)
            return JSONResponse(status_code=409, content={"error": "invoice_claim_lost"})
        try:
            settled = await self.verifier.settle(
                payload, invoice.requirement, invoice.resource
            )
            validate_receipt(
                settled,
                requirement=invoice.requirement,
                resource=invoice.resource,
                max_fee_drops=self.config.max_payer_fee_drops,
                first_ledger_sequence=invoice.first_ledger_sequence,
            )
            if settled != receipt:
                raise VerificationRejected("settlement_receipt_mismatch")
        except SettlementNotAttempted as exc:
            rejected_body = {
                "error": str(exc),
                "retryable": False,
                "phase": "settle",
                "settlementAttempted": False,
            }
            self.store.mark_rejected(
                invoice_id,
                fingerprint,
                receipt.transaction,
                rejected_body,
            )
            if budget_key is not None and not self.budget.release(budget_key):
                return JSONResponse(
                    status_code=503,
                    content={
                        "error": "budget_release_uncertain",
                        "retryable": True,
                        "phase": "settle",
                        "settlementAttempted": False,
                    },
                    headers={"Retry-After": "1"},
                )
            return JSONResponse(
                status_code=402,
                content=rejected_body,
            )
        except (VerificationRejected, VerificationError):
            if budget_key is not None:
                self.budget.mark_uncertain(budget_key)
        return await self._reconcile(transition.invoice, fingerprint)

    async def _reconcile(self, invoice: Any, fingerprint: str) -> JSONResponse:
        receipt = invoice.verified_receipt
        if receipt is None:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "settlement_status_unknown",
                    "retryable": False,
                    "phase": "reconcile",
                    "settlementAttempted": True,
                },
            )
        try:
            reconciliation = await self.verifier.reconcile(
                receipt,
                invoice.requirement,
                invoice.resource,
                self.config.max_payer_fee_drops,
                invoice.first_ledger_sequence,
            )
        except VerificationRejected as exc:
            return JSONResponse(status_code=402, content={"error": str(exc)})
        except VerificationError:
            reconciliation = None
        if reconciliation is None or reconciliation.status == "pending":
            if self.budget is not None:
                self.budget.mark_uncertain(invoice.invoice_id)
            return JSONResponse(
                status_code=503,
                content={
                    "error": "settlement_pending_validation",
                    "retryable": True,
                    "phase": "reconcile",
                    "settlementAttempted": True,
                },
                headers={"Retry-After": "1"},
            )
        if reconciliation.status == "not_included":
            assert reconciliation.validated_ledger_index is not None
            terminal = self.store.mark_not_included(
                invoice.invoice_id,
                fingerprint,
                receipt.transaction,
                reconciliation.validated_ledger_index,
            )
            if self.budget is not None:
                if not self.budget.release_not_included(invoice.invoice_id):
                    return JSONResponse(
                        status_code=503,
                        content={
                            "error": "budget_release_uncertain",
                            "retryable": True,
                            "phase": "reconcile",
                            "settlementAttempted": True,
                        },
                        headers={"Retry-After": "1"},
                    )
            return self._not_included_response(terminal)
        payment_response_body = {
            "success": True,
            "transaction": receipt.transaction,
            "network": "xrpl:1",
            "payer": receipt.payer,
        }
        if receipt.evidence_source == "deterministic-offline-fixture":
            payment_response_body["evidenceSource"] = receipt.evidence_source
        payment_response = encode_header(payment_response_body)
        if self.budget is not None and not self.budget.commit(invoice.invoice_id):
            return JSONResponse(status_code=503, content={"error": "budget_commit_uncertain", "retryable": False, "phase": "reconcile", "settlementAttempted": True})
        delivered = self.store.complete(
            invoice.invoice_id,
            fingerprint,
            receipt.transaction,
            self.merchant_body,
            payment_response,
        )
        assert delivered.response_body is not None
        assert delivered.payment_response is not None
        return JSONResponse(
            status_code=200,
            content=delivered.response_body,
            headers={"PAYMENT-RESPONSE": delivered.payment_response},
        )

    @staticmethod
    def _not_included_response(invoice: Any) -> JSONResponse:
        return JSONResponse(
            status_code=410,
            content={
                "error": "transaction_not_included_before_last_ledger_sequence",
                "retryable": False,
                "phase": "reconcile",
                "settlementAttempted": True,
                "validatedLedgerIndex": invoice.terminal_ledger_index,
            },
        )


def create_app(
    config: Optional[MerchantConfig] = None,
    verifier: Optional[PaymentFacilitator] = None,
    *,
    clock: Callable[[], float] = time.time,
    invoice_id_factory: Callable[[], str] = lambda: f"pilot-compare-{uuid.uuid4().hex}",
    offer: Optional[PaymentOffer] = None,
    budget: Optional[IssuedAssetBudgetLedger] = None,
    allow_fixture_evidence: bool = False,
    merchant_id: Optional[str] = None,
    resource_info: Mapping[str, Any] = RESOURCE_INFO,
    merchant_body: Mapping[str, Any] = MERCHANT_BODY,
) -> FastAPI:
    resolved_config = config or MerchantConfig.from_env()
    service = MerchantService(
        resolved_config,
        verifier
        or T54Facilitator(
            resolved_config.facilitator_url,
            xrpl_json_rpc_url=resolved_config.xrpl_json_rpc_url,
        ),
        clock=clock,
        invoice_id_factory=invoice_id_factory,
        offer=offer,
        budget=budget,
        allow_fixture_evidence=allow_fixture_evidence,
        merchant_id=merchant_id,
        resource_info=resource_info,
        merchant_body=merchant_body,
    )
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        service.startup()
        yield

    application = FastAPI(
        title="Pilot local XRPL Testnet x402 merchant", lifespan=lifespan
    )

    @application.middleware("http")
    async def loopback_only(request: Request, call_next: Any) -> JSONResponse:
        client_host = request.client.host if request.client is not None else ""
        try:
            client_is_loopback = ipaddress.ip_address(client_host).is_loopback
        except ValueError:
            client_is_loopback = False
        origin = request.headers.get("origin")
        forbidden_proxy_headers = any(
            name in request.headers
            for name in ("forwarded", "x-forwarded-for", "x-forwarded-host")
        )
        if (
            not client_is_loopback
            or request.headers.get("host") != LOOPBACK_HOST
            or (origin is not None and origin != LOOPBACK_ORIGIN)
            or forbidden_proxy_headers
        ):
            return JSONResponse(status_code=403, content={"error": "loopback_only"})
        return await call_next(request)

    @application.api_route(RESOURCE_PATH, methods=["GET", "POST"])
    async def compare(
        request: Request,
        payment_signature: Optional[str] = Header(default=None, alias="PAYMENT-SIGNATURE")
    ) -> JSONResponse:
        if payment_signature is None:
            return await service.issue_challenge()
        issued = isinstance(service.offer.asset, IssuedCurrencyAsset)
        expected_method = "POST" if issued else "GET"
        if request.method != expected_method:
            return JSONResponse(
                status_code=405,
                content={"error": "resource_method_mismatch"},
                headers={"Allow": expected_method},
            )
        return await service.paid_response(payment_signature, request.method)

    application.state.x402_service = service
    return application


app = create_app()
