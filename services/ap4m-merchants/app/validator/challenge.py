"""Mock/local challenge state with a production persistence seam.

The HTTP client receives only an opaque state handle.  All merchant, catalog,
settlement, ledger-window, and binding fields are reconstructed from trusted
server catalog records and retained here.  A production deployment must inject
a durable shared implementation of :class:`ChallengeStore`.
"""

import asyncio
import hashlib
import json
import re
import secrets
import sqlite3
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from validator.context import ChallengeContext, SettlementAsset

from ..catalog import Merchant


_STATE_ID = re.compile(r"^[A-Za-z0-9_-]{43}$")
_INTENT_ID = re.compile(r"^demo-intent-[A-Za-z0-9_-]{1,64}$")
_TX_HASH = re.compile(r"^[A-Fa-f0-9]{64}$")
_SENSITIVE_RESULT_KEYS = {
    "l1",
    "l2",
    "l3b",
    "payment_signature",
    "paymentsignature",
    "payment_token",
    "paymenttoken",
    "private_key",
    "privatekey",
    "secret",
    "signature",
    "signature_agent",
    "signatureagent",
    "signature_input",
    "signatureinput",
    "signed_tx_blob",
    "signedtxblob",
    "tx_blob",
    "txblob",
    "vi_l1",
    "vi_l2",
    "vi_l3b",
    "vil1",
    "vil2",
    "vil3b",
}


class ChallengeStateError(Exception):
    """Stable, non-sensitive challenge-state failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ChallengeLease:
    context: ChallengeContext
    owner_token: str
    intent_id: str
    payment_tx_hash: str
    checkpoint: dict[str, object] | None = None


class ChallengeStore(Protocol):
    def prepare(
        self, seller: Merchant, item: dict[str, object]
    ) -> tuple[str, ChallengeContext]: ...

    async def publish(self, context: ChallengeContext) -> None: ...

    async def get(self, state_id: str) -> ChallengeContext: ...

    async def acquire(self, state_id: str) -> ChallengeContext: ...

    async def release(self, state_id: str, owner_token: str | None = None) -> None: ...

    async def consume(self, state_id: str) -> None: ...

    async def complete(
        self,
        state_id: str,
        intent_id: str,
        payment_tx_hash: str,
        merchant_result: Mapping[str, object],
        owner_token: str | None = None,
    ) -> None: ...

    async def recover(
        self, state_id: str, intent_id: str, payment_tx_hash: str
    ) -> dict[str, object] | None: ...

    async def completed_context(self, state_id: str) -> ChallengeContext | None: ...

    async def acquire_fenced(
        self, state_id: str, intent_id: str, payment_tx_hash: str
    ) -> ChallengeLease: ...

    async def checkpoint(
        self,
        lease: ChallengeLease,
        merchant_result: Mapping[str, object],
    ) -> None: ...


@dataclass
class InMemoryMockChallengeStore:
    """TTL/cap-bounded mock-local store; never suitable as production state."""

    now: Callable[[], int]
    ttl_seconds: int = 300
    max_entries: int = 256
    current_ledger_index: int = 10_000
    max_last_ledger_delta: int = 20
    max_fee_drops: int = 100
    lease_seconds: int = 30
    _entries: OrderedDict[str, tuple[int, bool, ChallengeContext]] = field(
        default_factory=OrderedDict
    )
    _completed: OrderedDict[
        str, tuple[int, str, str, ChallengeContext, dict[str, object]]
    ] = field(default_factory=OrderedDict)
    _leases: dict[str, tuple[str, int, str, str]] = field(default_factory=dict)
    _checkpoints: dict[str, dict[str, object]] = field(default_factory=dict)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        if not 1 <= self.ttl_seconds <= 300:
            raise ValueError("mock challenge TTL must be between 1 and 300 seconds")
        if not 1 <= self.max_entries <= 1024:
            raise ValueError("mock challenge capacity must be between 1 and 1024")
        if not 1 <= self.lease_seconds <= 300:
            raise ValueError("challenge lease must be between 1 and 300 seconds")

    def _purge(self, now: int) -> None:
        expired = [
            key for key, (expiry, _, _) in self._entries.items() if expiry <= now
        ]
        for key in expired:
            self._entries.pop(key, None)
            self._leases.pop(key, None)
            self._checkpoints.pop(key, None)
        completed_expired = [
            key
            for key, (expiry, _, _, _, _) in self._completed.items()
            if expiry <= now
        ]
        for key in completed_expired:
            self._completed.pop(key, None)

    def _now(self) -> int:
        now = self.now()
        if not isinstance(now, int) or isinstance(now, bool) or now < 0:
            raise ChallengeStateError("CHALLENGE_CLOCK_INVALID", "challenge clock invalid")
        return now

    def prepare(
        self, seller: Merchant, item: dict[str, object]
    ) -> tuple[str, ChallengeContext]:
        price = item.get("price")
        if not isinstance(price, dict):
            raise ChallengeStateError("CATALOG_INVALID", "catalog settlement is invalid")
        asset = price.get("asset")
        if not isinstance(asset, dict) or not isinstance(price.get("value"), str):
            raise ChallengeStateError("CATALOG_INVALID", "catalog settlement is invalid")
        kind = asset.get("kind")
        if kind == "iou":
            code = asset.get("currency")
            issuer = asset.get("issuer")
            if not isinstance(code, str) or not isinstance(issuer, str):
                raise ChallengeStateError("CATALOG_INVALID", "catalog asset is invalid")
        elif kind == "xrp":
            code, issuer = "XRP", None
        else:
            raise ChallengeStateError("CATALOG_INVALID", "catalog asset is invalid")
        price_usd_cents = item.get("price_usd_cents")
        if (
            not isinstance(price_usd_cents, int)
            or isinstance(price_usd_cents, bool)
            or price_usd_cents <= 0
        ):
            raise ChallengeStateError("CATALOG_INVALID", "catalog USD price is invalid")

        state_id = secrets.token_urlsafe(32)
        seed = hashlib.sha256(
            f"ap4m-mm2-v1\0{state_id}\0{seller.id}\0{item.get('sku', '')}".encode()
        ).digest()
        invoice_id = f"ap4m-{state_id}"
        l3a_digest = hashlib.sha256(b"l3a\0" + seed).hexdigest()
        context = ChallengeContext(
            state_id=state_id,
            merchant_id=seller.id,
            merchant_name=seller.name,
            src_dpa_id=seller.src_dpa_id,
            merchant_address=seller.xrpl_address,
            sku=str(item.get("sku", "")),
            price_usd_cents=price_usd_cents,
            settlement=SettlementAsset(code, issuer, price["value"]),
            network_id=1,
            source_tag=seller.source_tag,
            destination_tag=seller.destination_tag,
            invoice_id=invoice_id,
            l3a_digest=l3a_digest,
            current_ledger_index=self.current_ledger_index,
            max_last_ledger_delta=self.max_last_ledger_delta,
            max_fee_drops=self.max_fee_drops,
            resource_description=str(item.get("description", "")),
        )
        return state_id, context

    async def publish(self, context: ChallengeContext) -> None:
        now = self._now()
        async with self._lock:
            self._purge(now)
            if context.state_id in self._entries:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_COLLISION", "challenge state collision"
                )
            if context.state_id in self._completed:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_COLLISION", "challenge state collision"
                )
            if len(self._entries) + len(self._completed) >= self.max_entries:
                raise ChallengeStateError(
                    "CHALLENGE_STORE_FULL", "challenge store capacity reached"
                )
            self._entries[context.state_id] = (
                now + self.ttl_seconds,
                False,
                context,
            )

    async def issue(
        self, seller: Merchant, item: dict[str, object]
    ) -> tuple[str, ChallengeContext]:
        """Test/local convenience; HTTP flows prepare, authenticate, then publish."""

        state_id, context = self.prepare(seller, item)
        await self.publish(context)
        return state_id, context

    async def get(self, state_id: str) -> ChallengeContext:
        if not isinstance(state_id, str) or _STATE_ID.fullmatch(state_id) is None:
            raise ChallengeStateError("CHALLENGE_STATE_INVALID", "challenge state is invalid")
        now = self._now()
        async with self._lock:
            self._purge(now)
            entry = self._entries.get(state_id)
            if entry is None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
                )
            self._entries.move_to_end(state_id)
            return entry[2]

    async def acquire(self, state_id: str) -> ChallengeContext:
        if not isinstance(state_id, str) or _STATE_ID.fullmatch(state_id) is None:
            raise ChallengeStateError("CHALLENGE_STATE_INVALID", "challenge state is invalid")
        now = self._now()
        async with self._lock:
            self._purge(now)
            entry = self._entries.get(state_id)
            if entry is None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
                )
            expiry, in_flight, context = entry
            if in_flight:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_IN_FLIGHT", "challenge state is already in use"
                )
            self._entries[state_id] = (expiry, True, context)
            self._entries.move_to_end(state_id)
            return context

    async def release(self, state_id: str, owner_token: str | None = None) -> None:
        now = self._now()
        async with self._lock:
            self._purge(now)
            entry = self._entries.get(state_id)
            if entry is not None:
                lease = self._leases.get(state_id)
                if lease is not None and owner_token != lease[0]:
                    raise ChallengeStateError(
                        "CHALLENGE_LEASE_NOT_OWNER", "challenge lease owner does not match"
                    )
                expiry, _, context = entry
                self._entries[state_id] = (expiry, False, context)
                self._leases.pop(state_id, None)
                self._checkpoints.pop(state_id, None)

    async def consume(self, state_id: str) -> None:
        async with self._lock:
            self._entries.pop(state_id, None)
            self._completed.pop(state_id, None)
            self._leases.pop(state_id, None)
            self._checkpoints.pop(state_id, None)

    async def complete(
        self,
        state_id: str,
        intent_id: str,
        payment_tx_hash: str,
        merchant_result: Mapping[str, object],
        owner_token: str | None = None,
    ) -> None:
        intent_id, payment_tx_hash, result = _completion_values(
            state_id, intent_id, payment_tx_hash, merchant_result
        )
        now = self._now()
        async with self._lock:
            self._purge(now)
            completed = self._completed.get(state_id)
            if completed is not None:
                _, existing_intent, existing_hash, _, existing_result = completed
                if (
                    existing_intent == intent_id
                    and existing_hash == payment_tx_hash
                    and existing_result == result
                ):
                    return
                raise ChallengeStateError(
                    "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                )
            if any(
                existing_intent == intent_id or existing_hash == payment_tx_hash
                for _, existing_intent, existing_hash, _, _ in self._completed.values()
            ):
                raise ChallengeStateError(
                    "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                )
            entry = self._entries.get(state_id)
            if entry is None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
                )
            expiry, in_flight, context = entry
            if not in_flight:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_NOT_ACQUIRED", "challenge state is not acquired"
                )
            lease = self._leases.get(state_id)
            if lease is not None and owner_token != lease[0]:
                raise ChallengeStateError(
                    "CHALLENGE_LEASE_NOT_OWNER", "challenge lease owner does not match"
                )
            checkpoint = self._checkpoints.get(state_id)
            if lease is not None and checkpoint != result:
                raise ChallengeStateError(
                    "CHALLENGE_CHECKPOINT_MISMATCH",
                    "validated challenge checkpoint does not match",
                )
            self._entries.pop(state_id)
            self._leases.pop(state_id, None)
            self._checkpoints.pop(state_id, None)
            self._completed[state_id] = (
                expiry,
                intent_id,
                payment_tx_hash,
                context,
                result,
            )

    async def recover(
        self, state_id: str, intent_id: str, payment_tx_hash: str
    ) -> dict[str, object] | None:
        intent_id, payment_tx_hash, _ = _completion_values(
            state_id, intent_id, payment_tx_hash, {}
        )
        now = self._now()
        async with self._lock:
            self._purge(now)
            completed = self._completed.get(state_id)
            if completed is None:
                if any(
                    existing_intent == intent_id or existing_hash == payment_tx_hash
                    for _, existing_intent, existing_hash, _, _ in self._completed.values()
                ):
                    raise ChallengeStateError(
                        "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                    )
                return None
            _, existing_intent, existing_hash, _, result = completed
            if existing_intent != intent_id or existing_hash != payment_tx_hash:
                raise ChallengeStateError(
                    "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                )
            self._completed.move_to_end(state_id)
            return json.loads(json.dumps(result))

    async def completed_context(self, state_id: str) -> ChallengeContext | None:
        if not isinstance(state_id, str) or _STATE_ID.fullmatch(state_id) is None:
            raise ChallengeStateError(
                "CHALLENGE_STATE_INVALID", "challenge state is invalid"
            )
        now = self._now()
        async with self._lock:
            self._purge(now)
            completed = self._completed.get(state_id)
            return None if completed is None else completed[3]

    async def acquire_fenced(
        self, state_id: str, intent_id: str, payment_tx_hash: str
    ) -> ChallengeLease:
        intent_id, payment_tx_hash, _ = _completion_values(
            state_id, intent_id, payment_tx_hash, {}
        )
        now = self._now()
        async with self._lock:
            self._purge(now)
            entry = self._entries.get(state_id)
            if entry is None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
                )
            expiry, in_flight, context = entry
            lease = self._leases.get(state_id)
            if in_flight:
                if lease is None:
                    raise ChallengeStateError(
                        "CHALLENGE_STATE_IN_FLIGHT", "challenge state is already in use"
                    )
                _, started, existing_intent, existing_hash = lease
                if existing_intent != intent_id or existing_hash != payment_tx_hash:
                    raise ChallengeStateError(
                        "CHALLENGE_REPLAY_MISMATCH", "processing challenge does not match"
                    )
                if now - started < self.lease_seconds:
                    raise ChallengeStateError(
                        "CHALLENGE_STATE_IN_FLIGHT", "challenge state is already in use"
                    )
            owner_token = secrets.token_urlsafe(32)
            self._entries[state_id] = (expiry, True, context)
            self._leases[state_id] = (
                owner_token,
                now,
                intent_id,
                payment_tx_hash,
            )
            checkpoint = self._checkpoints.get(state_id)
            return ChallengeLease(
                context,
                owner_token,
                intent_id,
                payment_tx_hash,
                None if checkpoint is None else json.loads(json.dumps(checkpoint)),
            )

    async def checkpoint(
        self,
        lease: ChallengeLease,
        merchant_result: Mapping[str, object],
    ) -> None:
        _, _, result = _completion_values(
            lease.context.state_id,
            lease.intent_id,
            lease.payment_tx_hash,
            merchant_result,
        )
        async with self._lock:
            current = self._leases.get(lease.context.state_id)
            if current is None or current[0] != lease.owner_token:
                raise ChallengeStateError(
                    "CHALLENGE_LEASE_NOT_OWNER", "challenge lease owner does not match"
                )
            self._checkpoints[lease.context.state_id] = result


_CONTEXT_FIELDS = {
    "state_id",
    "merchant_id",
    "merchant_name",
    "src_dpa_id",
    "merchant_address",
    "sku",
    "price_usd_cents",
    "settlement",
    "network_id",
    "source_tag",
    "destination_tag",
    "invoice_id",
    "l3a_digest",
    "current_ledger_index",
    "max_last_ledger_delta",
    "max_fee_drops",
    "allowed_payment_flags",
    "resource_description",
}


def _safe_result_value(value: object, *, depth: int = 0) -> None:
    if depth > 8:
        raise ChallengeStateError(
            "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
        )
    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, str):
        if len(value) > 16_384:
            raise ChallengeStateError(
                "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
            )
        return
    if isinstance(value, list):
        if len(value) > 256:
            raise ChallengeStateError(
                "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
            )
        for item in value:
            _safe_result_value(item, depth=depth + 1)
        return
    if isinstance(value, Mapping):
        if len(value) > 256:
            raise ChallengeStateError(
                "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
            )
        for key, item in value.items():
            normalized_key = (
                re.sub(r"[^a-z0-9]", "", key.lower())
                if isinstance(key, str)
                else ""
            )
            if (
                not isinstance(key, str)
                or not key
                or len(key) > 128
                or key.lower().replace("-", "_") in _SENSITIVE_RESULT_KEYS
                or normalized_key in _SENSITIVE_RESULT_KEYS
            ):
                raise ChallengeStateError(
                    "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
                )
            _safe_result_value(item, depth=depth + 1)
        return
    raise ChallengeStateError(
        "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
    )


def _completion_values(
    state_id: str,
    intent_id: str,
    payment_tx_hash: str,
    merchant_result: Mapping[str, object],
) -> tuple[str, str, dict[str, object]]:
    if (
        not isinstance(state_id, str)
        or _STATE_ID.fullmatch(state_id) is None
        or not isinstance(intent_id, str)
        or _INTENT_ID.fullmatch(intent_id) is None
        or not isinstance(payment_tx_hash, str)
        or _TX_HASH.fullmatch(payment_tx_hash) is None
        or not isinstance(merchant_result, Mapping)
    ):
        raise ChallengeStateError(
            "CHALLENGE_COMPLETION_INVALID", "challenge completion is invalid"
        )
    _safe_result_value(merchant_result)
    try:
        serialized = json.dumps(
            merchant_result, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        result = json.loads(serialized)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ChallengeStateError(
            "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
        ) from exc
    if len(serialized.encode("utf-8")) > 32_768 or not isinstance(result, dict):
        raise ChallengeStateError(
            "CHALLENGE_RESULT_INVALID", "cached merchant result is invalid"
        )
    return intent_id, payment_tx_hash.upper(), result


def _context_json(context: ChallengeContext) -> str:
    value = {
        "state_id": context.state_id,
        "merchant_id": context.merchant_id,
        "merchant_name": context.merchant_name,
        "src_dpa_id": context.src_dpa_id,
        "merchant_address": context.merchant_address,
        "sku": context.sku,
        "price_usd_cents": context.price_usd_cents,
        "settlement": {
            "code": context.settlement.code,
            "issuer": context.settlement.issuer,
            "value": context.settlement.value,
        },
        "network_id": context.network_id,
        "source_tag": context.source_tag,
        "destination_tag": context.destination_tag,
        "invoice_id": context.invoice_id,
        "l3a_digest": context.l3a_digest,
        "current_ledger_index": context.current_ledger_index,
        "max_last_ledger_delta": context.max_last_ledger_delta,
        "max_fee_drops": context.max_fee_drops,
        "allowed_payment_flags": context.allowed_payment_flags,
        "resource_description": context.resource_description,
    }
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _context_from_json(serialized: str) -> ChallengeContext:
    try:
        value = json.loads(serialized)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ChallengeStateError(
            "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
        ) from exc
    if not isinstance(value, dict) or set(value) != _CONTEXT_FIELDS:
        raise ChallengeStateError(
            "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
        )
    settlement = value.get("settlement")
    if not isinstance(settlement, dict) or set(settlement) != {
        "code",
        "issuer",
        "value",
    }:
        raise ChallengeStateError(
            "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
        )
    string_fields = (
        "state_id",
        "merchant_id",
        "merchant_name",
        "src_dpa_id",
        "merchant_address",
        "sku",
        "invoice_id",
        "l3a_digest",
        "resource_description",
    )
    integer_fields = (
        "price_usd_cents",
        "network_id",
        "source_tag",
        "current_ledger_index",
        "max_last_ledger_delta",
        "max_fee_drops",
        "allowed_payment_flags",
    )
    if (
        any(
            not isinstance(value.get(name), str) or len(value[name]) > 1_024
            for name in string_fields
        )
        or _STATE_ID.fullmatch(value["state_id"]) is None
        or any(
            not isinstance(value.get(name), int) or isinstance(value[name], bool)
            for name in integer_fields
        )
        or (
            value.get("destination_tag") is not None
            and (
                not isinstance(value["destination_tag"], int)
                or isinstance(value["destination_tag"], bool)
            )
        )
        or not isinstance(settlement.get("code"), str)
        or not isinstance(settlement.get("value"), str)
        or (
            settlement.get("issuer") is not None
            and not isinstance(settlement.get("issuer"), str)
        )
    ):
        raise ChallengeStateError(
            "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
        )
    return ChallengeContext(
        state_id=value["state_id"],
        merchant_id=value["merchant_id"],
        merchant_name=value["merchant_name"],
        src_dpa_id=value["src_dpa_id"],
        merchant_address=value["merchant_address"],
        sku=value["sku"],
        price_usd_cents=value["price_usd_cents"],
        settlement=SettlementAsset(
            settlement["code"], settlement["issuer"], settlement["value"]
        ),
        network_id=value["network_id"],
        source_tag=value["source_tag"],
        destination_tag=value["destination_tag"],
        invoice_id=value["invoice_id"],
        l3a_digest=value["l3a_digest"],
        current_ledger_index=value["current_ledger_index"],
        max_last_ledger_delta=value["max_last_ledger_delta"],
        max_fee_drops=value["max_fee_drops"],
        allowed_payment_flags=value["allowed_payment_flags"],
        resource_description=value["resource_description"],
    )


@dataclass
class SQLiteChallengeStore:
    """Durable single-host challenge state behind the existing store protocol.

    The database path is injected. SQLite transactions coordinate workers that
    share that file; multi-host deployments must inject another implementation.
    This class is intentionally not wired into the mock or live runtime here.
    """

    database_path: str | Path
    now: Callable[[], int]
    ttl_seconds: int = 300
    max_entries: int = 256
    current_ledger_index: int = 10_000
    max_last_ledger_delta: int = 20
    max_fee_drops: int = 100
    lease_seconds: int = 30
    timeout_seconds: float = 2.0
    _projector: InMemoryMockChallengeStore = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.database_path, (str, Path)) or not str(
            self.database_path
        ):
            raise ValueError("challenge database must be a filesystem path")
        path = Path(self.database_path)
        if str(path) == ":memory:":
            raise ValueError("challenge database must be a filesystem path")
        if not isinstance(self.timeout_seconds, (int, float)) or isinstance(
            self.timeout_seconds, bool
        ):
            raise ValueError("challenge database timeout is invalid")
        if not 0.05 <= self.timeout_seconds <= 5.0:
            raise ValueError(
                "challenge database timeout must be between 0.05 and 5 seconds"
            )
        self._projector = InMemoryMockChallengeStore(
            now=self.now,
            ttl_seconds=self.ttl_seconds,
            max_entries=self.max_entries,
            current_ledger_index=self.current_ledger_index,
            max_last_ledger_delta=self.max_last_ledger_delta,
            max_fee_drops=self.max_fee_drops,
            lease_seconds=self.lease_seconds,
        )
        self.database_path = path
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database_path,
            timeout=float(self.timeout_seconds),
            isolation_level=None,
        )
        connection.execute(f"PRAGMA busy_timeout={int(self.timeout_seconds * 1_000)}")
        return connection

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS ap4m_challenges (
                    state_id TEXT PRIMARY KEY,
                    expires INTEGER NOT NULL,
                    in_flight INTEGER NOT NULL CHECK (in_flight IN (0, 1)),
                    owner_token TEXT,
                    lease_started INTEGER,
                    intent_id TEXT,
                    payment_tx_hash TEXT,
                    checkpoint_json TEXT,
                    context_json TEXT NOT NULL
                ) WITHOUT ROWID
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS ap4m_challenge_completions (
                    state_id TEXT PRIMARY KEY,
                    expires INTEGER NOT NULL,
                    intent_id TEXT NOT NULL,
                    payment_tx_hash TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    result_json TEXT NOT NULL
                ) WITHOUT ROWID
                """
            )
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS
                    ap4m_challenge_completions_intent
                ON ap4m_challenge_completions (intent_id)
                """
            )
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS
                    ap4m_challenge_completions_payment
                ON ap4m_challenge_completions (payment_tx_hash)
                """
            )
        finally:
            connection.close()

    def _now(self) -> int:
        return self._projector._now()

    def prepare(
        self, seller: Merchant, item: dict[str, object]
    ) -> tuple[str, ChallengeContext]:
        return self._projector.prepare(seller, item)

    async def publish(self, context: ChallengeContext) -> None:
        await asyncio.to_thread(self._publish_sync, context, self._now())

    def _publish_sync(self, context: ChallengeContext, now: int) -> None:
        if _STATE_ID.fullmatch(context.state_id) is None:
            raise ChallengeStateError(
                "CHALLENGE_STATE_INVALID", "challenge state is invalid"
            )
        serialized = _context_json(context)
        _context_from_json(serialized)
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM ap4m_challenges WHERE expires <= ?", (now,))
            connection.execute(
                "DELETE FROM ap4m_challenge_completions WHERE expires <= ?", (now,)
            )
            existing = connection.execute(
                "SELECT 1 FROM ap4m_challenges WHERE state_id = ?", (context.state_id,)
            ).fetchone()
            completed = connection.execute(
                "SELECT 1 FROM ap4m_challenge_completions WHERE state_id = ?",
                (context.state_id,),
            ).fetchone()
            if existing is not None or completed is not None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_COLLISION", "challenge state collision"
                )
            count = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM ap4m_challenges) +
                    (SELECT COUNT(*) FROM ap4m_challenge_completions)
                """
            ).fetchone()
            if count is None or count[0] >= self.max_entries:
                raise ChallengeStateError(
                    "CHALLENGE_STORE_FULL", "challenge store capacity reached"
                )
            connection.execute(
                """
                INSERT INTO ap4m_challenges
                    (state_id, expires, in_flight, context_json)
                VALUES (?, ?, 0, ?)
                """,
                (context.state_id, now + self.ttl_seconds, serialized),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def get(self, state_id: str) -> ChallengeContext:
        return await asyncio.to_thread(self._get_sync, state_id, self._now(), False)

    async def acquire(self, state_id: str) -> ChallengeContext:
        return await asyncio.to_thread(self._get_sync, state_id, self._now(), True)

    def _get_sync(
        self, state_id: str, now: int, acquire: bool
    ) -> ChallengeContext:
        if not isinstance(state_id, str) or _STATE_ID.fullmatch(state_id) is None:
            raise ChallengeStateError(
                "CHALLENGE_STATE_INVALID", "challenge state is invalid"
            )
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM ap4m_challenges WHERE expires <= ?", (now,))
            row = connection.execute(
                """
                SELECT in_flight, context_json
                FROM ap4m_challenges
                WHERE state_id = ?
                """,
                (state_id,),
            ).fetchone()
            if row is None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
                )
            if acquire and row[0] == 1:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_IN_FLIGHT", "challenge state is already in use"
                )
            context = _context_from_json(row[1])
            if context.state_id != state_id:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
                )
            if acquire:
                connection.execute(
                    "UPDATE ap4m_challenges SET in_flight = 1 WHERE state_id = ?",
                    (state_id,),
                )
            connection.commit()
            return context
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def release(self, state_id: str, owner_token: str | None = None) -> None:
        await asyncio.to_thread(
            self._release_sync, state_id, self._now(), owner_token
        )

    def _release_sync(
        self, state_id: str, now: int, owner_token: str | None
    ) -> None:
        if not isinstance(state_id, str) or _STATE_ID.fullmatch(state_id) is None:
            return
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM ap4m_challenges WHERE expires <= ?", (now,))
            row = connection.execute(
                "SELECT owner_token FROM ap4m_challenges WHERE state_id = ?",
                (state_id,),
            ).fetchone()
            if row is not None and row[0] is not None and row[0] != owner_token:
                raise ChallengeStateError(
                    "CHALLENGE_LEASE_NOT_OWNER", "challenge lease owner does not match"
                )
            connection.execute(
                """
                UPDATE ap4m_challenges
                SET in_flight = 0,
                    owner_token = NULL,
                    lease_started = NULL,
                    intent_id = NULL,
                    payment_tx_hash = NULL,
                    checkpoint_json = NULL
                WHERE state_id = ?
                """,
                (state_id,),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def consume(self, state_id: str) -> None:
        if not isinstance(state_id, str) or _STATE_ID.fullmatch(state_id) is None:
            return
        await asyncio.to_thread(self._consume_sync, state_id)

    def _consume_sync(self, state_id: str) -> None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM ap4m_challenges WHERE state_id = ?", (state_id,))
            connection.execute(
                "DELETE FROM ap4m_challenge_completions WHERE state_id = ?",
                (state_id,),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def complete(
        self,
        state_id: str,
        intent_id: str,
        payment_tx_hash: str,
        merchant_result: Mapping[str, object],
        owner_token: str | None = None,
    ) -> None:
        intent_id, payment_tx_hash, result = _completion_values(
            state_id, intent_id, payment_tx_hash, merchant_result
        )
        serialized = json.dumps(
            result, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        await asyncio.to_thread(
            self._complete_sync,
            state_id,
            intent_id,
            payment_tx_hash,
            serialized,
            self._now(),
            owner_token,
        )

    def _complete_sync(
        self,
        state_id: str,
        intent_id: str,
        payment_tx_hash: str,
        result_json: str,
        now: int,
        owner_token: str | None,
    ) -> None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM ap4m_challenges WHERE expires <= ?", (now,))
            connection.execute(
                "DELETE FROM ap4m_challenge_completions WHERE expires <= ?", (now,)
            )
            completed = connection.execute(
                """
                SELECT intent_id, payment_tx_hash, result_json
                FROM ap4m_challenge_completions
                WHERE state_id = ?
                """,
                (state_id,),
            ).fetchone()
            if completed is not None:
                if completed == (intent_id, payment_tx_hash, result_json):
                    connection.commit()
                    return
                raise ChallengeStateError(
                    "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                )
            duplicate = connection.execute(
                """
                SELECT 1
                FROM ap4m_challenge_completions
                WHERE intent_id = ? OR payment_tx_hash = ?
                """,
                (intent_id, payment_tx_hash),
            ).fetchone()
            if duplicate is not None:
                raise ChallengeStateError(
                    "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                )
            pending = connection.execute(
                """
                SELECT expires, in_flight, context_json, owner_token, checkpoint_json
                FROM ap4m_challenges
                WHERE state_id = ?
                """,
                (state_id,),
            ).fetchone()
            if pending is None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
                )
            if pending[1] != 1:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_NOT_ACQUIRED", "challenge state is not acquired"
                )
            if pending[3] is not None and pending[3] != owner_token:
                raise ChallengeStateError(
                    "CHALLENGE_LEASE_NOT_OWNER", "challenge lease owner does not match"
                )
            if pending[3] is not None and pending[4] != result_json:
                raise ChallengeStateError(
                    "CHALLENGE_CHECKPOINT_MISMATCH",
                    "validated challenge checkpoint does not match",
                )
            connection.execute("DELETE FROM ap4m_challenges WHERE state_id = ?", (state_id,))
            connection.execute(
                """
                INSERT INTO ap4m_challenge_completions
                    (
                        state_id, expires, intent_id, payment_tx_hash,
                        context_json, result_json
                    )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    state_id,
                    pending[0],
                    intent_id,
                    payment_tx_hash,
                    pending[2],
                    result_json,
                ),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def acquire_fenced(
        self, state_id: str, intent_id: str, payment_tx_hash: str
    ) -> ChallengeLease:
        intent_id, payment_tx_hash, _ = _completion_values(
            state_id, intent_id, payment_tx_hash, {}
        )
        return await asyncio.to_thread(
            self._acquire_fenced_sync,
            state_id,
            intent_id,
            payment_tx_hash,
            self._now(),
        )

    def _acquire_fenced_sync(
        self,
        state_id: str,
        intent_id: str,
        payment_tx_hash: str,
        now: int,
    ) -> ChallengeLease:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM ap4m_challenges WHERE expires <= ?", (now,))
            row = connection.execute(
                """
                SELECT
                    expires, in_flight, owner_token, lease_started,
                    intent_id, payment_tx_hash, checkpoint_json, context_json
                FROM ap4m_challenges
                WHERE state_id = ?
                """,
                (state_id,),
            ).fetchone()
            if row is None:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_EXPIRED", "challenge state is missing or expired"
                )
            if row[1] == 1:
                if row[2] is None:
                    raise ChallengeStateError(
                        "CHALLENGE_STATE_IN_FLIGHT", "challenge state is already in use"
                    )
                if row[4] != intent_id or row[5] != payment_tx_hash:
                    raise ChallengeStateError(
                        "CHALLENGE_REPLAY_MISMATCH", "processing challenge does not match"
                    )
                if now - row[3] < self.lease_seconds:
                    raise ChallengeStateError(
                        "CHALLENGE_STATE_IN_FLIGHT", "challenge state is already in use"
                    )
            context = _context_from_json(row[7])
            if context.state_id != state_id:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
                )
            checkpoint = None
            if row[6] is not None:
                try:
                    checkpoint = json.loads(row[6])
                except (json.JSONDecodeError, RecursionError) as exc:
                    raise ChallengeStateError(
                        "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
                    ) from exc
                _safe_result_value(checkpoint)
                if not isinstance(checkpoint, dict):
                    raise ChallengeStateError(
                        "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
                    )
            owner_token = secrets.token_urlsafe(32)
            connection.execute(
                """
                UPDATE ap4m_challenges
                SET in_flight = 1,
                    owner_token = ?,
                    lease_started = ?,
                    intent_id = ?,
                    payment_tx_hash = ?
                WHERE state_id = ?
                """,
                (owner_token, now, intent_id, payment_tx_hash, state_id),
            )
            connection.commit()
            return ChallengeLease(
                context,
                owner_token,
                intent_id,
                payment_tx_hash,
                checkpoint,
            )
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def checkpoint(
        self,
        lease: ChallengeLease,
        merchant_result: Mapping[str, object],
    ) -> None:
        _, _, result = _completion_values(
            lease.context.state_id,
            lease.intent_id,
            lease.payment_tx_hash,
            merchant_result,
        )
        serialized = json.dumps(
            result, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        await asyncio.to_thread(self._checkpoint_sync, lease, serialized)

    def _checkpoint_sync(self, lease: ChallengeLease, result_json: str) -> None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT owner_token, intent_id, payment_tx_hash
                FROM ap4m_challenges
                WHERE state_id = ?
                """,
                (lease.context.state_id,),
            ).fetchone()
            if row != (
                lease.owner_token,
                lease.intent_id,
                lease.payment_tx_hash,
            ):
                raise ChallengeStateError(
                    "CHALLENGE_LEASE_NOT_OWNER", "challenge lease owner does not match"
                )
            connection.execute(
                """
                UPDATE ap4m_challenges
                SET checkpoint_json = ?
                WHERE state_id = ?
                """,
                (result_json, lease.context.state_id),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def recover(
        self, state_id: str, intent_id: str, payment_tx_hash: str
    ) -> dict[str, object] | None:
        intent_id, payment_tx_hash, _ = _completion_values(
            state_id, intent_id, payment_tx_hash, {}
        )
        return await asyncio.to_thread(
            self._recover_sync, state_id, intent_id, payment_tx_hash, self._now()
        )

    def _recover_sync(
        self, state_id: str, intent_id: str, payment_tx_hash: str, now: int
    ) -> dict[str, object] | None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM ap4m_challenge_completions WHERE expires <= ?", (now,)
            )
            row = connection.execute(
                """
                SELECT intent_id, payment_tx_hash, result_json
                FROM ap4m_challenge_completions
                WHERE state_id = ?
                """,
                (state_id,),
            ).fetchone()
            if row is None:
                mismatch = connection.execute(
                    """
                    SELECT 1
                    FROM ap4m_challenge_completions
                    WHERE intent_id = ? OR payment_tx_hash = ?
                    """,
                    (intent_id, payment_tx_hash),
                ).fetchone()
                if mismatch is not None:
                    raise ChallengeStateError(
                        "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                    )
                connection.commit()
                return None
            if row[0] != intent_id or row[1] != payment_tx_hash:
                raise ChallengeStateError(
                    "CHALLENGE_REPLAY_MISMATCH", "completed challenge does not match"
                )
            try:
                result = json.loads(row[2])
            except (json.JSONDecodeError, RecursionError) as exc:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
                ) from exc
            _safe_result_value(result)
            connection.commit()
            return result
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def completed_context(self, state_id: str) -> ChallengeContext | None:
        if not isinstance(state_id, str) or _STATE_ID.fullmatch(state_id) is None:
            raise ChallengeStateError(
                "CHALLENGE_STATE_INVALID", "challenge state is invalid"
            )
        return await asyncio.to_thread(
            self._completed_context_sync, state_id, self._now()
        )

    def _completed_context_sync(
        self, state_id: str, now: int
    ) -> ChallengeContext | None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM ap4m_challenge_completions WHERE expires <= ?", (now,)
            )
            row = connection.execute(
                """
                SELECT context_json
                FROM ap4m_challenge_completions
                WHERE state_id = ?
                """,
                (state_id,),
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            context = _context_from_json(row[0])
            if context.state_id != state_id:
                raise ChallengeStateError(
                    "CHALLENGE_STATE_CORRUPT", "challenge state is corrupt"
                )
            connection.commit()
            return context
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
