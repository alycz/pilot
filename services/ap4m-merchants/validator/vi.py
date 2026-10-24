"""Verifiable Intent reference-result projection and AP4M binding checks."""

import base64
import hashlib
import json
import re
from collections.abc import Mapping

from .context import MerchantValidationRequest, ValidatorDependencies, ViVerification
from .errors import fail
from .intent import IntentFacts


_SHA256_HEX = re.compile(r"^[a-f0-9]{64}$")


def _bounded_strings(value: object) -> bool:
    return (
        isinstance(value, tuple)
        and 1 <= len(value) <= 32
        and all(isinstance(item, str) and 1 <= len(item) <= 128 for item in value)
    )


def checkout_digest(request: MerchantValidationRequest) -> str:
    challenge = request.challenge
    payment_terms = {
        "amount": challenge.settlement.value,
        "currency": challenge.settlement.code,
        "issuer": challenge.settlement.issuer,
        "network": request.network,
        "payTo": challenge.merchant_address,
        "scheme": "exact",
    }
    canonical = json.dumps(
        {"intent": request.intent, "payment_terms": payment_terms},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return (
        base64.urlsafe_b64encode(hashlib.sha256(canonical).digest())
        .decode()
        .rstrip("=")
    )


async def verify_vi(
    request: MerchantValidationRequest,
    facts: IntentFacts,
    dependencies: ValidatorDependencies,
) -> ViVerification:
    if request.vi_chain is None:
        fail("intent", "VI_CHAIN_REQUIRED", "Verifiable Intent chain is required")
    if dependencies.vi_verifier is None:
        fail("intent", "VI_REFERENCE_UNAVAILABLE", "reference verifier unavailable", 503)
    chain = request.vi_chain
    if not isinstance(chain, Mapping):
        fail("intent", "VI_CHAIN_MALFORMED", "chain bundle must be an object")
    if set(chain) != {"version", "l1", "l2", "l3b"} or chain.get("version") != "vi-v0.1":
        fail("intent", "VI_CHAIN_MALFORMED", "chain bundle is not the v0.1 shape")
    if not all(
        isinstance(chain.get(name), str) and chain.get(name)
        for name in ("l1", "l2", "l3b")
    ):
        fail("intent", "VI_CHAIN_MALFORMED", "chain presentations are required")

    verified = await dependencies.vi_verifier(chain, request)
    if verified.signatures_valid is not True:
        fail("intent", "VI_SIGNATURE_INVALID", "chain signature verification failed")
    if verified.l1_l2_bound is not True or verified.l2_l3_bound is not True:
        fail("intent", "VI_BINDING_INVALID", "chain disclosure binding failed")
    if verified.l1_issuer != dependencies.trusted_l1_issuer:
        fail("intent", "VI_ISSUER_UNTRUSTED", "L1 issuer is not trusted")
    if request.expected_owner is not None and verified.owner != request.expected_owner:
        fail("intent", "VI_OWNER_MISMATCH", "mandate owner does not match")
    if (
        request.expected_budget_account is not None
        and verified.budget_account != request.expected_budget_account
    ):
        fail("intent", "VI_BUDGET_MISMATCH", "budget account does not match")
    if not isinstance(verified.payer, str) or not 1 <= len(verified.payer) <= 128:
        fail("intent", "VI_PAYER_MISMATCH", "authorized payer is missing")
    if verified.of_verified is not True:
        fail("intent", "VI_OPEN_FINANCE_UNVERIFIED", "Open Finance proof is not verified")
    if verified.raw_of_identifiers_present is not False:
        fail("intent", "VI_OPEN_FINANCE_RAW_ID", "raw Open Finance identifiers are forbidden")
    if (
        not isinstance(verified.of_owner_name_hash, str)
        or not isinstance(verified.of_customer_ref, str)
        or not _SHA256_HEX.fullmatch(verified.of_owner_name_hash)
        or not _SHA256_HEX.fullmatch(verified.of_customer_ref)
    ):
        fail("intent", "VI_OPEN_FINANCE_HASH_INVALID", "Open Finance hashes are invalid")
    if (
        not _bounded_strings(verified.allowed_payees)
        or request.challenge.merchant_id not in verified.allowed_payees
    ):
        fail("intent", "VI_PAYEE_BLOCKED", "payee is outside the mandate")
    if (
        not _bounded_strings(verified.allowed_merchants)
        or request.challenge.merchant_id not in verified.allowed_merchants
    ):
        fail("intent", "VI_MERCHANT_BLOCKED", "merchant is outside the mandate")
    if (
        not _bounded_strings(verified.allowed_skus)
        or request.challenge.sku not in verified.allowed_skus
    ):
        fail("intent", "VI_SKU_BLOCKED", "item is outside the mandate")
    if verified.constraint_currency != "USD":
        fail("intent", "VI_CURRENCY_BLOCKED", "mandate constraint currency is not USD")
    if verified.recurrence != "ON_DEMAND":
        fail("intent", "VI_RECURRENCE_INVALID", "recurrence is not ON_DEMAND")
    if (
        not isinstance(verified.per_payment_max_usd_cents, int)
        or isinstance(verified.per_payment_max_usd_cents, bool)
        or verified.per_payment_max_usd_cents > 9_007_199_254_740_991
        or verified.per_payment_max_usd_cents < facts.total_usd_cents
    ):
        fail("intent", "VI_AMOUNT_BLOCKED", "intent exceeds the mandate")
    if (
        not isinstance(verified.expires_at, int)
        or isinstance(verified.expires_at, bool)
        or verified.expires_at <= dependencies.now()
    ):
        fail("intent", "VI_EXPIRED", "mandate has expired")
    expected_hash = checkout_digest(request)
    if verified.checkout_hash != expected_hash:
        fail("intent", "VI_CHECKOUT_MISMATCH", "checkout hash does not match")
    return verified
