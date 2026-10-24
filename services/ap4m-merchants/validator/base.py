"""Ordered Mastercard Level 3 validator orchestration."""

from collections.abc import Awaitable, Callable, Mapping
from typing import TypeVar

from .context import (
    Check,
    MerchantValidationRequest,
    ValidationEvent,
    ValidationOutcome,
    ValidatorDependencies,
    ViVerification,
    WbaIdentity,
)
from .credential import CredentialFacts, verify_credential
from .errors import Stage, ValidationFailure
from .intent import IntentFacts, valid_intent_id, validate_intent
from .payment import verify_payment
from .vi import verify_vi
from .wba import verify_wba


T = TypeVar("T")
_STAGES: tuple[Stage, ...] = ("wba", "intent", "credential", "payment")


def _intent_id(request: MerchantValidationRequest) -> str:
    if not isinstance(request.intent, Mapping):
        return "demo-intent-unverified"
    value = request.intent.get("intentId")
    return value if valid_intent_id(value) else "demo-intent-unverified"


async def validate_checkout(
    request: MerchantValidationRequest,
    dependencies: ValidatorDependencies,
) -> ValidationOutcome:
    intent_id = _intent_id(request)
    checks: dict[str, Check] = {stage: "fail" for stage in _STAGES}
    events: list[ValidationEvent] = []
    error: ValidationFailure | None = None
    result_hash: str | None = None

    async def run(stage: Stage, action: Callable[[], Awaitable[T]]) -> T | None:
        nonlocal error
        if error is not None:
            events.append(
                ValidationEvent(
                    stage,
                    "fail",
                    request.merchant_id,
                    request.sku,
                    intent_id,
                    "UPSTREAM_STAGE_FAILED",
                )
            )
            return None
        try:
            value = await action()
        except ValidationFailure as failure:
            error = failure
            events.append(
                ValidationEvent(
                    stage,
                    "fail",
                    request.merchant_id,
                    request.sku,
                    intent_id,
                    failure.code,
                )
            )
            return None
        checks[stage] = "pass"
        events.append(
            ValidationEvent(stage, "pass", request.merchant_id, request.sku, intent_id)
        )
        return value

    wba_identity: WbaIdentity | None = None
    if dependencies.identity_mode == "skipped":
        checks["wba"] = "skipped"
        events.append(
            ValidationEvent("wba", "skipped", request.merchant_id, request.sku, intent_id)
        )
    else:
        wba_identity = await run("wba", lambda: verify_wba(request, dependencies))

    async def intent_action() -> tuple[IntentFacts, ViVerification]:
        facts = validate_intent(request, dependencies.now())
        verified = await verify_vi(request, facts, dependencies)
        return facts, verified

    intent_result = await run("intent", intent_action)
    credential: CredentialFacts | None = None
    if intent_result is not None:
        _, verified = intent_result
        credential = await run(
            "credential",
            lambda: verify_credential(
                request,
                dependencies,
                verified.payer,
                wba_identity,
            ),
        )
    else:
        async def unreachable_credential() -> None:
            raise AssertionError("blocked credential stage executed")

        await run("credential", unreachable_credential)
    if credential is not None:
        payment = await run(
            "payment", lambda: verify_payment(request, credential, dependencies)
        )
        if payment is not None:
            result_hash = payment.tx_hash
    else:
        async def unreachable_payment() -> None:
            raise AssertionError("blocked payment stage executed")

        await run("payment", unreachable_payment)

    validation_errors = () if error is None else (error.code,)
    validated = (
        error is None
        and checks["intent"] == checks["credential"] == checks["payment"] == "pass"
    )
    return ValidationOutcome(
        intent_id=intent_id,
        validated=validated,
        http_status=200 if validated else (error.http_status if error else 400),
        checks=checks,
        validation_errors=validation_errors,
        events=tuple(events),
        tx_hash=result_hash,
    )
