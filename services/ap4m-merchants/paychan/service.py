"""Fail-closed payment-channel claim acceptance and merchant redemption."""

import asyncio
import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace

from .context import (
    ChannelReader,
    ClaimAcceptance,
    ClaimEventSink,
    ClaimProof,
    ClaimRecord,
    ClaimStore,
    LocalVerifier,
    MerchantSubmitter,
    RippledChannelVerifier,
    SettlementResult,
    SourceCredentialReader,
)
from .crypto import LocalVerifierUnavailable, canonical_drops, normalize_proof, verify_claim_signature
from validator.context import MerchantValidationRequest, PaymentResult


_HEX_64 = re.compile(r"^[0-9A-F]{64}$")


class PaychanFailure(RuntimeError):
    def __init__(self, code: str, message: str, http_status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


@dataclass(frozen=True)
class PaychanDependencies:
    channel_reader: ChannelReader | None
    credential_reader: SourceCredentialReader | None
    store: ClaimStore | None
    now_ripple: object
    local_verifier: LocalVerifier = verify_claim_signature
    rippled_verifier: RippledChannelVerifier | None = None
    submitter: MerchantSubmitter | None = None
    event_sink: ClaimEventSink | None = None
    auto_settle_every: int | None = None
    enabled: bool = True


class PaychanRuntime:
    def __init__(self, dependencies: PaychanDependencies) -> None:
        self.dependencies = dependencies
        self._settlement_locks: dict[tuple[str, str], asyncio.Lock] = {}
        every = dependencies.auto_settle_every
        if every is not None and (isinstance(every, bool) or every <= 0):
            raise ValueError("auto_settle_every must be a positive integer")
        if every is not None and dependencies.submitter is None:
            raise ValueError("auto_settle_every requires a submitter")

    @staticmethod
    def _parse_proof(value: ClaimProof | Mapping[str, object]) -> ClaimProof:
        if isinstance(value, ClaimProof):
            proof = value
        elif isinstance(value, Mapping) and set(value) == {
            "channel_id",
            "cumulative_drops",
            "signature",
            "public_key",
        }:
            proof = ClaimProof(
                channel_id=value["channel_id"],  # type: ignore[arg-type]
                cumulative_drops=value["cumulative_drops"],  # type: ignore[arg-type]
                signature=value["signature"],  # type: ignore[arg-type]
                public_key=value["public_key"],  # type: ignore[arg-type]
            )
        else:
            raise PaychanFailure("PAYCHAN_PROOF_INVALID", "claim proof shape is invalid")
        try:
            return normalize_proof(proof)
        except (TypeError, ValueError) as exc:
            raise PaychanFailure("PAYCHAN_PROOF_INVALID", "claim proof is invalid") from exc

    @classmethod
    def _retry_key_for_claim(cls, proof: ClaimProof) -> str:
        material = "\x00".join(
            (
                "ap4m/paychan-claim-retry/v1",
                proof.channel_id,
                proof.cumulative_drops,
                proof.signature,
                proof.public_key,
            )
        )
        return hashlib.sha256(material.encode("ascii")).hexdigest().upper()

    @classmethod
    def retry_key(cls, value: ClaimProof | Mapping[str, object]) -> str:
        """Return the domain-separated internal id for one exact claim proof.

        Validator-facing mappings must retain the discriminant so another
        payment scheme can never collide with this projection. Internal callers
        may pass an already parsed ``ClaimProof``.
        """

        if isinstance(value, ClaimProof):
            proof = cls._parse_proof(value)
        elif isinstance(value, Mapping) and set(value) == {
            "type",
            "channel_id",
            "cumulative_drops",
            "signature",
            "public_key",
        } and value.get("type") == "xrpl_paychan_claim":
            proof = cls._parse_proof(
                {
                    "channel_id": value["channel_id"],
                    "cumulative_drops": value["cumulative_drops"],
                    "signature": value["signature"],
                    "public_key": value["public_key"],
                }
            )
        else:
            raise PaychanFailure("PAYCHAN_PROOF_INVALID", "claim proof shape is invalid")
        return cls._retry_key_for_claim(proof)

    async def validate_claim(
        self,
        request: MerchantValidationRequest,
        *,
        credentialed_payer: str,
    ) -> PaymentResult:
        """Adapt the MM3 verifier to the ordered MM2 payment-stage protocol.

        The returned ``tx_hash`` is a legacy internal payment identifier. It is
        deliberately not represented as an XRPL transaction hash or live
        redemption evidence.
        """

        raw = request.payment_proof
        if raw is None:
            raise PaychanFailure("PAYCHAN_PROOF_INVALID", "claim proof shape is invalid")
        claim_id = self.retry_key(raw)
        proof = self._parse_proof(
            {
                "channel_id": raw["channel_id"],
                "cumulative_drops": raw["cumulative_drops"],
                "signature": raw["signature"],
                "public_key": raw["public_key"],
            }
        )
        expected_increment = getattr(request.challenge, "paychan_claim_drops", None)
        try:
            expected_increment = canonical_drops(expected_increment)
        except (TypeError, ValueError) as exc:
            raise PaychanFailure(
                "PAYCHAN_PRICE_INVALID", "trusted channel price is invalid", 500
            ) from exc
        acceptance = await self.accept_claim(
            request.challenge.merchant_id,
            request.challenge.merchant_address,
            proof,
            credentialed_payer=credentialed_payer,
            expected_increment_drops=expected_increment,
            acceptance_key=request.challenge.state_id,
        )
        if acceptance.claim_id != claim_id:
            raise PaychanFailure(
                "PAYCHAN_IDENTITY_MISMATCH", "claim identity does not match accepted proof", 500
            )
        return PaymentResult(
            tx_hash=claim_id,
            validated=True,
            engine_result=acceptance.status,
            delivered_currency="XRP",
            delivered_issuer=None,
            delivered_value=expected_increment,
        )

    def _require_acceptance_dependencies(self) -> tuple[ChannelReader, SourceCredentialReader, ClaimStore]:
        deps = self.dependencies
        if (
            not deps.enabled
            or deps.channel_reader is None
            or deps.credential_reader is None
            or deps.store is None
        ):
            raise PaychanFailure(
                "PAYCHAN_DISABLED", "payment-channel verification is not configured", 503
            )
        return deps.channel_reader, deps.credential_reader, deps.store

    async def accept_claim(
        self,
        merchant_id: str,
        merchant_destination: str,
        proof: ClaimProof | Mapping[str, object],
        *,
        credentialed_payer: str | None = None,
        expected_increment_drops: str,
        acceptance_key: str,
    ) -> ClaimAcceptance:
        channel_reader, credential_reader, store = self._require_acceptance_dependencies()
        if not merchant_id or not merchant_destination:
            raise PaychanFailure("PAYCHAN_CONTEXT_INVALID", "merchant context is invalid", 500)
        if (
            not isinstance(acceptance_key, str)
            or not acceptance_key
            or len(acceptance_key) > 128
        ):
            raise PaychanFailure("PAYCHAN_CONTEXT_INVALID", "claim replay scope is invalid", 500)
        claim = self._parse_proof(proof)
        try:
            expected_increment = canonical_drops(expected_increment_drops)
        except (TypeError, ValueError) as exc:
            raise PaychanFailure(
                "PAYCHAN_PRICE_INVALID", "trusted channel price is invalid", 500
            ) from exc
        channel = await channel_reader.read_channel(claim.channel_id)
        if channel is None:
            raise PaychanFailure("PAYCHAN_CHANNEL_NOT_FOUND", "payment channel was not found", 402)
        try:
            normalized_channel_id = normalize_proof(
                ClaimProof(
                    channel_id=channel.channel_id,
                    cumulative_drops=claim.cumulative_drops,
                    signature=claim.signature,
                    public_key=claim.public_key,
                )
            ).channel_id
            amount = canonical_drops(channel.amount_drops)
            balance = canonical_drops(channel.balance_drops, allow_zero=True)
        except (TypeError, ValueError) as exc:
            raise PaychanFailure(
                "PAYCHAN_LEDGER_STATE_INVALID", "payment channel state is invalid", 503
            ) from exc
        if normalized_channel_id != claim.channel_id:
            raise PaychanFailure("PAYCHAN_CHANNEL_MISMATCH", "payment channel id does not match")
        if channel.destination != merchant_destination:
            raise PaychanFailure(
                "PAYCHAN_DESTINATION_MISMATCH", "payment channel destination is not this merchant", 402
            )
        if credentialed_payer is not None and channel.source != credentialed_payer:
            raise PaychanFailure(
                "PAYCHAN_SOURCE_MISMATCH", "payment channel source does not match credentialed payer", 402
            )
        if await credential_reader.accepted_source(channel.source) is not True:
            raise PaychanFailure(
                "PAYCHAN_CREDENTIAL_NOT_ACCEPTED", "channel source credential is not accepted", 403
            )
        if not isinstance(channel.public_key, str) or channel.public_key.upper() != claim.public_key:
            raise PaychanFailure(
                "PAYCHAN_PUBLIC_KEY_MISMATCH", "claim public key does not match channel", 402
            )
        cumulative = int(claim.cumulative_drops)
        if cumulative <= int(balance):
            raise PaychanFailure(
                "PAYCHAN_CLAIM_NOT_INCREASING", "claim does not exceed the channel balance", 409
            )
        if cumulative > int(amount):
            raise PaychanFailure("PAYCHAN_AMOUNT_EXCEEDED", "claim exceeds channel amount", 402)
        if (
            isinstance(channel.settle_delay_seconds, bool)
            or not isinstance(channel.settle_delay_seconds, int)
            or channel.settle_delay_seconds <= 0
        ):
            raise PaychanFailure(
                "PAYCHAN_LEDGER_STATE_INVALID", "channel SettleDelay is invalid", 503
            )
        now_provider = self.dependencies.now_ripple
        if not callable(now_provider):
            raise PaychanFailure("PAYCHAN_TIME_UNAVAILABLE", "ledger time is unavailable", 503)
        now = now_provider()
        if isinstance(now, bool) or not isinstance(now, int) or now < 0:
            raise PaychanFailure("PAYCHAN_TIME_UNAVAILABLE", "ledger time is unavailable", 503)
        safety_limit = now + channel.settle_delay_seconds
        closing_times = tuple(
            value
            for value in (channel.expiration_ripple, channel.cancel_after_ripple)
            if value is not None
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in closing_times
        ):
            raise PaychanFailure(
                "PAYCHAN_LEDGER_STATE_INVALID", "channel close time is invalid", 503
            )
        if any(value <= safety_limit for value in closing_times):
            raise PaychanFailure(
                "PAYCHAN_CLOSING_SOON", "channel may close within its SettleDelay margin", 409
            )
        try:
            verified = self.dependencies.local_verifier(claim)
        except LocalVerifierUnavailable:
            fallback = self.dependencies.rippled_verifier
            if fallback is None:
                raise PaychanFailure(
                    "PAYCHAN_VERIFIER_UNAVAILABLE", "claim verifier is unavailable", 503
                )
            try:
                verified = await fallback.channel_verify(
                    claim.channel_id,
                    claim.cumulative_drops,
                    claim.signature,
                    claim.public_key,
                )
            except Exception as exc:
                raise PaychanFailure(
                    "PAYCHAN_VERIFIER_UNAVAILABLE", "claim verifier is unavailable", 503
                ) from exc
        if verified is not True:
            raise PaychanFailure("PAYCHAN_SIGNATURE_INVALID", "claim signature is invalid", 402)
        stored = await store.accept(
            merchant_id=merchant_id,
            channel=channel,
            proof=claim,
            expected_increment_drops=expected_increment,
            acceptance_key=acceptance_key,
        )
        if stored.status == "stale":
            raise PaychanFailure(
                "PAYCHAN_CLAIM_NOT_INCREASING", "claim does not exceed the highest accepted claim", 409
            )
        if stored.status == "conflict":
            raise PaychanFailure(
                "PAYCHAN_CLAIM_CONFLICT", "claim conflicts with an accepted cumulative amount", 409
            )
        if stored.status == "amount_mismatch":
            raise PaychanFailure(
                "PAYCHAN_AMOUNT_MISMATCH",
                "claim increment does not match the trusted merchant price",
                402,
            )
        record = stored.record
        every = self.dependencies.auto_settle_every
        due = stored.status == "accepted" and every is not None and record.accepted_count % every == 0
        acceptance = ClaimAcceptance(
            status="claim_replay" if stored.status == "replay" else "claim_accepted",
            claim_id=self._retry_key_for_claim(claim),
            merchant_id=merchant_id,
            channel_id=record.channel_id,
            source=record.source,
            cumulative_drops=record.cumulative_drops,
            accepted_count=record.accepted_count,
            settlement_due=due,
        )
        if due:
            if self.dependencies.submitter is None:
                raise PaychanFailure(
                    "PAYCHAN_SETTLEMENT_DISABLED",
                    "automatic settlement is configured without a submitter",
                    503,
                )
            await self.settle(merchant_id, record.channel_id)
        return acceptance

    async def pending(self, merchant_id: str) -> tuple[ClaimRecord, ...]:
        store = self.dependencies.store
        if not self.dependencies.enabled or store is None:
            raise PaychanFailure("PAYCHAN_DISABLED", "payment-channel store is not configured", 503)
        return await store.pending(merchant_id)

    async def _emit_redemption(self, merchant_id: str, record: ClaimRecord) -> bool:
        """Deliver the durable redemption event without risking a resubmission.

        A sink failure leaves the durable emitted bit clear. A later replay
        retries only the event, never the ledger submission. Delivery is
        intentionally at-least-once across a process crash because the event
        sink and SQLite store do not share a transaction.
        """

        deps = self.dependencies
        if record.redeemed_tx_hash is None:
            return False
        if deps.event_sink is not None:
            try:
                await deps.event_sink(
                    "claim_redeemed",
                    {
                        "merchant_id": merchant_id,
                        "channel_id": record.channel_id,
                        "cumulative_drops": record.redeemed_drops,
                        "tx_hash": record.redeemed_tx_hash,
                    },
                )
            except Exception:
                return False
        if deps.store is not None:
            return await deps.store.mark_redemption_event_emitted(
                record.channel_id, record.redeemed_drops, record.redeemed_tx_hash
            )
        return False

    async def settle(
        self, merchant_id: str, channel_id: str | None = None
    ) -> SettlementResult:
        deps = self.dependencies
        if not deps.enabled or deps.store is None or deps.submitter is None:
            raise PaychanFailure(
                "PAYCHAN_SETTLEMENT_DISABLED", "payment-channel redemption is not configured", 503
            )
        pending = await deps.store.pending(merchant_id, channel_id)
        if len(pending) > 1 and channel_id is None:
            raise PaychanFailure(
                "PAYCHAN_CHANNEL_REQUIRED", "select a channel when multiple claims are pending", 409
            )
        resolved_channel = pending[0].channel_id if pending else channel_id
        if resolved_channel is None:
            raise PaychanFailure("PAYCHAN_NO_PENDING", "no accepted claim is pending", 409)
        lock = self._settlement_locks.setdefault(
            (merchant_id, resolved_channel), asyncio.Lock()
        )
        async with lock:
            reservation = await deps.store.reserve_redemption(
                merchant_id, resolved_channel
            )
            if reservation.status == "uncertain":
                raise PaychanFailure(
                    "PAYCHAN_SETTLEMENT_UNCERTAIN",
                    "payment-channel redemption outcome is uncertain",
                    409,
                )
            if reservation.status == "missing" or reservation.record is None:
                raise PaychanFailure("PAYCHAN_NO_PENDING", "no accepted claim is pending", 409)
            record = reservation.record
            if reservation.status == "replay":
                if record.redeemed_tx_hash is None:
                    raise PaychanFailure("PAYCHAN_NO_PENDING", "no accepted claim is pending", 409)
                if not record.redemption_event_emitted:
                    if not await self._emit_redemption(merchant_id, record):
                        raise PaychanFailure(
                            "PAYCHAN_EVENT_PENDING",
                            "validated redemption event delivery is pending",
                            503,
                        )
                return SettlementResult(
                    channel_id=record.channel_id,
                    cumulative_drops=record.redeemed_drops,
                    tx_hash=record.redeemed_tx_hash,
                    replayed=True,
                )
            transaction = {
                "TransactionType": "PaymentChannelClaim",
                "Channel": record.channel_id,
                "Balance": record.cumulative_drops,
                "Amount": record.cumulative_drops,
                "Signature": record.signature,
                "PublicKey": record.public_key,
            }
            try:
                submitted = await deps.submitter.submit_payment_channel_claim(
                    merchant_id, transaction
                )
            except Exception as exc:
                raise PaychanFailure(
                    "PAYCHAN_SUBMIT_FAILED", "payment-channel redemption failed", 502
                ) from exc
            tx_hash = submitted.tx_hash.upper() if isinstance(submitted.tx_hash, str) else ""
            if (
                not _HEX_64.fullmatch(tx_hash)
                or submitted.validated is not True
                or submitted.engine_result != "tesSUCCESS"
            ):
                raise PaychanFailure(
                    "PAYCHAN_NOT_REDEEMED", "payment-channel redemption was not validated", 402
                )
            if not await deps.store.complete_redemption(
                record.channel_id, record.cumulative_drops, tx_hash
            ):
                raise PaychanFailure(
                    "PAYCHAN_REDEEM_RACE",
                    "a newer claim arrived while redemption was in flight",
                    409,
                )
            await self._emit_redemption(
                merchant_id,
                replace(
                    record,
                    redeemed_drops=record.cumulative_drops,
                    redeemed_tx_hash=tx_hash,
                    redeeming_drops=None,
                    redemption_event_emitted=False,
                ),
            )
            return SettlementResult(
                channel_id=record.channel_id,
                cumulative_drops=record.cumulative_drops,
                tx_hash=tx_hash,
                replayed=False,
            )


def build_disabled_runtime() -> PaychanRuntime:
    """Return the application default: no reader, signer, submitter, or network."""

    return PaychanRuntime(
        PaychanDependencies(
            channel_reader=None,
            credential_reader=None,
            store=None,
            now_ripple=lambda: 0,
            enabled=False,
        )
    )
