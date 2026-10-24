"""Typed boundaries between the validator and future concrete transports."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol


Check = Literal["pass", "fail", "skipped"]
IdentityMode = Literal["required", "skipped"]
PaymentMode = Literal["mock", "live"]


@dataclass(frozen=True)
class SettlementAsset:
    code: str
    issuer: str | None
    value: str


@dataclass(frozen=True)
class ChallengeContext:
    """Server-resolved catalog and 402 state; never reconstructed from headers."""

    state_id: str
    merchant_id: str
    merchant_name: str
    src_dpa_id: str
    merchant_address: str
    sku: str
    price_usd_cents: int
    settlement: SettlementAsset
    network_id: int
    source_tag: int
    destination_tag: int | None
    invoice_id: str
    l3a_digest: str
    current_ledger_index: int
    max_last_ledger_delta: int
    max_fee_drops: int
    allowed_payment_flags: int = 0x80000000
    resource_description: str = ""
    # Both current demo merchants advertise the same fixed 50,000-drop claim
    # increment. A future variable price must be carried through the durable
    # challenge serializer and rendered from this field in the 402 response.
    paychan_claim_drops: str = "50000"


@dataclass(frozen=True)
class MerchantValidationRequest:
    challenge: ChallengeContext
    network: Literal["testnet"]
    intent: Mapping[str, object]
    vi_chain: Mapping[str, object] | None
    payment_proof: Mapping[str, object] | None
    method: str = "POST"
    authority: str = "merchant.invalid"
    path: str = "/"
    wba: Mapping[str, object] | None = None
    expected_owner: str | None = None
    expected_budget_account: str | None = None
    expected_mandate_id: str | None = None
    expected_l3_nonce: str | None = None

    @property
    def merchant_id(self) -> str:
        return self.challenge.merchant_id

    @property
    def sku(self) -> str:
        return self.challenge.sku


@dataclass(frozen=True)
class ViVerification:
    signatures_valid: bool
    l1_l2_bound: bool
    l2_l3_bound: bool
    l1_issuer: str
    owner: str
    budget_account: str
    payer: str
    of_verified: bool
    of_owner_name_hash: str
    of_customer_ref: str
    raw_of_identifiers_present: bool
    allowed_payees: tuple[str, ...]
    allowed_merchants: tuple[str, ...]
    allowed_skus: tuple[str, ...]
    per_payment_max_usd_cents: int
    constraint_currency: str
    recurrence: str
    expires_at: int
    checkout_hash: str


@dataclass(frozen=True)
class DecodedPayment:
    transaction_type: str
    account: str
    destination: str
    currency: str
    issuer: str | None
    value: str
    credential_ids: tuple[str, ...]
    tx_hash: str
    flags: int
    network_id: int | None
    source_tag: int
    destination_tag: int | None
    invoice_id: str
    memos: tuple[str, ...]
    last_ledger_sequence: int
    fee_drops: str
    unknown_fields: tuple[str, ...]


@dataclass(frozen=True)
class CredentialRecord:
    credential_id: str
    issuer: str
    credential_type: str
    subject: str
    accepted: bool
    expiration_ripple: int | None


@dataclass(frozen=True)
class PaymentResult:
    tx_hash: str
    validated: bool
    engine_result: str
    delivered_currency: str
    delivered_issuer: str | None
    delivered_value: str


@dataclass(frozen=True)
class DirectoryFetchPolicy:
    max_bytes: int = 16_384
    max_keys: int = 4
    timeout_ms: int = 2_000
    allow_redirects: bool = False


@dataclass(frozen=True)
class DirectoryDocument:
    body: Mapping[str, object]
    final_url: str
    redirected: bool
    size_bytes: int
    status_code: int
    media_type: str
    cache_control: str


@dataclass(frozen=True)
class WbaIdentity:
    issuer: str
    credential_type: str
    subject: str


class DirectoryLoader(Protocol):
    def __call__(
        self, url: str, policy: DirectoryFetchPolicy
    ) -> Awaitable[DirectoryDocument]: ...


class ViVerifier(Protocol):
    def __call__(
        self,
        chain: Mapping[str, object],
        request: MerchantValidationRequest,
    ) -> Awaitable[ViVerification]: ...


class PaymentDecoder(Protocol):
    def __call__(self, tx_blob: str) -> Awaitable[DecodedPayment]: ...


class LedgerReader(Protocol):
    def read_credential(self, credential_id: str) -> Awaitable[CredentialRecord]: ...

    def channel_source(self, channel_id: str) -> Awaitable[str]: ...

    def accepted_subject_credential(
        self, subject: str, issuer: str, credential_type: str
    ) -> Awaitable[CredentialRecord | None]: ...


class PaymentTransport(Protocol):
    def validate_exact(
        self,
        payment: DecodedPayment,
        request: MerchantValidationRequest,
    ) -> Awaitable[PaymentResult]: ...


class PaychanVerifier(Protocol):
    """Injected MM3 claim verifier; it performs no transport by default.

    ``retry_key`` is a pure, strict projection of the five-field payment proof.
    The returned identifier is stored in the legacy ``payment_tx_hash`` fields,
    but it is a claim identity, never an XRPL transaction hash.
    """

    def retry_key(self, proof: Mapping[str, object]) -> str: ...

    def validate_claim(
        self,
        request: MerchantValidationRequest,
        *,
        credentialed_payer: str,
    ) -> Awaitable[PaymentResult]: ...


class NonceStore(Protocol):
    async def claim(self, keyid: str, nonce: str, expires: int, now: int) -> bool:
        """Atomically reserve an unused nonce until expiry."""
        ...


@dataclass
class InMemoryAtomicNonceStore:
    """Locked test/local store. Production must inject a durable atomic store."""

    _claims: dict[tuple[str, str], int] = field(default_factory=dict)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def claim(self, keyid: str, nonce: str, expires: int, now: int) -> bool:
        async with self._lock:
            self._claims = {
                key: expiry for key, expiry in self._claims.items() if expiry > now
            }
            key = (keyid, nonce)
            if key in self._claims:
                return False
            self._claims[key] = expires
            return True


@dataclass
class WbaState:
    directory_cache: dict[str, tuple[int, DirectoryDocument]] = field(
        default_factory=dict
    )


@dataclass(frozen=True)
class ValidatorDependencies:
    now: Callable[[], int]
    identity_mode: IdentityMode
    payment_mode: PaymentMode
    expected_wba_origin: str
    expected_wba_tag: str
    accepted_wba_subject: str
    trusted_l1_issuer: str
    trusted_credential_issuer: str
    credential_type_hex: str
    directory_loader: DirectoryLoader | None
    vi_verifier: ViVerifier | None
    payment_decoder: PaymentDecoder | None
    ledger_reader: LedgerReader | None
    payment_transport: PaymentTransport | None
    nonce_store: NonceStore
    wba_state: WbaState
    directory_policy: DirectoryFetchPolicy = DirectoryFetchPolicy()
    allow_live: bool = False
    paychan_verifier: PaychanVerifier | None = None


@dataclass(frozen=True)
class ValidationEvent:
    stage: Literal["wba", "intent", "credential", "payment"]
    result: Check
    merchant_id: str
    sku: str
    intent_id: str
    error_code: str | None = None


@dataclass(frozen=True)
class ValidationOutcome:
    intent_id: str
    validated: bool
    http_status: int
    checks: Mapping[str, Check]
    validation_errors: tuple[str, ...]
    events: tuple[ValidationEvent, ...]
    tx_hash: str | None = None
