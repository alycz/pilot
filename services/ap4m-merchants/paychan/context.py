"""Typed, injection-only boundaries for XRPL payment-channel claims."""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class ClaimProof:
    channel_id: str
    cumulative_drops: str
    signature: str
    public_key: str


@dataclass(frozen=True)
class ChannelState:
    channel_id: str
    source: str
    destination: str
    amount_drops: str
    balance_drops: str
    public_key: str
    settle_delay_seconds: int
    expiration_ripple: int | None = None
    cancel_after_ripple: int | None = None


@dataclass(frozen=True)
class ClaimRecord:
    merchant_id: str
    channel_id: str
    source: str
    destination: str
    cumulative_drops: str
    signature: str
    public_key: str
    acceptance_key: str
    accepted_count: int
    redeemed_drops: str = "0"
    redeemed_tx_hash: str | None = None
    redeeming_drops: str | None = None
    redemption_event_emitted: bool = False


@dataclass(frozen=True)
class StoreAcceptance:
    status: Literal["accepted", "replay", "stale", "conflict", "amount_mismatch"]
    record: ClaimRecord


@dataclass(frozen=True)
class RedemptionReservation:
    status: Literal["reserved", "replay", "uncertain", "missing"]
    record: ClaimRecord | None


@dataclass(frozen=True)
class ClaimAcceptance:
    status: Literal["claim_accepted", "claim_replay"]
    claim_id: str
    merchant_id: str
    channel_id: str
    source: str
    cumulative_drops: str
    accepted_count: int
    settlement_due: bool


@dataclass(frozen=True)
class SubmissionResult:
    tx_hash: str
    validated: bool
    engine_result: str


@dataclass(frozen=True)
class SettlementResult:
    channel_id: str
    cumulative_drops: str
    tx_hash: str
    replayed: bool


class ChannelReader(Protocol):
    def read_channel(self, channel_id: str) -> Awaitable[ChannelState | None]: ...


class SourceCredentialReader(Protocol):
    def accepted_source(self, source: str) -> Awaitable[bool]: ...


class RippledChannelVerifier(Protocol):
    def channel_verify(
        self,
        channel_id: str,
        cumulative_drops: str,
        signature: str,
        public_key: str,
    ) -> Awaitable[bool]: ...


class ClaimStore(Protocol):
    async def accept(
        self,
        *,
        merchant_id: str,
        channel: ChannelState,
        proof: ClaimProof,
        expected_increment_drops: str,
        acceptance_key: str,
    ) -> StoreAcceptance: ...

    async def pending(
        self, merchant_id: str, channel_id: str | None = None
    ) -> tuple[ClaimRecord, ...]: ...

    async def latest(
        self, merchant_id: str, channel_id: str | None = None
    ) -> tuple[ClaimRecord, ...]: ...

    async def reserve_redemption(
        self, merchant_id: str, channel_id: str
    ) -> RedemptionReservation: ...

    async def complete_redemption(
        self, channel_id: str, cumulative_drops: str, tx_hash: str
    ) -> bool: ...

    async def mark_redemption_event_emitted(
        self, channel_id: str, cumulative_drops: str, tx_hash: str
    ) -> bool: ...


class MerchantSubmitter(Protocol):
    def submit_payment_channel_claim(
        self, merchant_id: str, transaction: Mapping[str, str]
    ) -> Awaitable[SubmissionResult]: ...


class ClaimEventSink(Protocol):
    def __call__(self, kind: str, detail: Mapping[str, str]) -> Awaitable[object]: ...


LocalVerifier = Callable[[ClaimProof], bool]

