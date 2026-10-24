"""Atomic claim stores for the merchant payment-channel verifier."""

import asyncio
import sqlite3
from dataclasses import replace
from pathlib import Path

from .context import (
    ChannelState,
    ClaimProof,
    ClaimRecord,
    RedemptionReservation,
    StoreAcceptance,
)


def _record_from_row(row: sqlite3.Row) -> ClaimRecord:
    return ClaimRecord(
        merchant_id=row["merchant_id"],
        channel_id=row["channel_id"],
        source=row["source"],
        destination=row["destination"],
        cumulative_drops=row["cumulative_drops"],
        signature=row["signature"],
        public_key=row["public_key"],
        acceptance_key=row["acceptance_key"],
        accepted_count=row["accepted_count"],
        redeemed_drops=row["redeemed_drops"],
        redeemed_tx_hash=row["redeemed_tx_hash"],
        redeeming_drops=row["redeeming_drops"],
        redemption_event_emitted=bool(row["redemption_event_emitted"]),
    )


class InMemoryClaimStore:
    """Locked store for bounded unit tests and explicit injected mock runs."""

    def __init__(self) -> None:
        self._records: dict[str, ClaimRecord] = {}
        self._lock = asyncio.Lock()

    async def accept(
        self,
        *,
        merchant_id: str,
        channel: ChannelState,
        proof: ClaimProof,
        expected_increment_drops: str,
        acceptance_key: str,
    ) -> StoreAcceptance:
        async with self._lock:
            previous = self._records.get(proof.channel_id)
            floor = max(
                int(channel.balance_drops),
                int(previous.cumulative_drops) if previous else 0,
            )
            if previous and int(proof.cumulative_drops) == int(previous.cumulative_drops):
                status = (
                    "replay"
                    if proof.signature == previous.signature
                    and proof.public_key == previous.public_key
                    and acceptance_key == previous.acceptance_key
                    else "conflict"
                )
                return StoreAcceptance(status=status, record=previous)
            if int(proof.cumulative_drops) <= floor:
                record = previous or ClaimRecord(
                    merchant_id=merchant_id,
                    channel_id=proof.channel_id,
                    source=channel.source,
                    destination=channel.destination,
                    cumulative_drops=str(floor),
                    signature="",
                    public_key=proof.public_key,
                    acceptance_key=acceptance_key,
                    accepted_count=0,
                )
                return StoreAcceptance(status="stale", record=record)
            if int(proof.cumulative_drops) != floor + int(expected_increment_drops):
                return StoreAcceptance(
                    status="amount_mismatch",
                    record=previous
                    or ClaimRecord(
                        merchant_id=merchant_id,
                        channel_id=proof.channel_id,
                        source=channel.source,
                        destination=channel.destination,
                        cumulative_drops=str(floor),
                        signature="",
                        public_key=proof.public_key,
                        acceptance_key=acceptance_key,
                        accepted_count=0,
                    ),
                )
            record = ClaimRecord(
                merchant_id=merchant_id,
                channel_id=proof.channel_id,
                source=channel.source,
                destination=channel.destination,
                cumulative_drops=proof.cumulative_drops,
                signature=proof.signature,
                public_key=proof.public_key,
                acceptance_key=acceptance_key,
                accepted_count=(previous.accepted_count + 1 if previous else 1),
                redeemed_drops=previous.redeemed_drops if previous else "0",
                redeemed_tx_hash=previous.redeemed_tx_hash if previous else None,
                redeeming_drops=previous.redeeming_drops if previous else None,
                redemption_event_emitted=(
                    previous.redemption_event_emitted if previous else False
                ),
            )
            self._records[proof.channel_id] = record
            return StoreAcceptance(status="accepted", record=record)

    async def pending(
        self, merchant_id: str, channel_id: str | None = None
    ) -> tuple[ClaimRecord, ...]:
        async with self._lock:
            return tuple(
                record
                for record in self._records.values()
                if record.merchant_id == merchant_id
                and (channel_id is None or record.channel_id == channel_id)
                and (
                    int(record.cumulative_drops) > int(record.redeemed_drops)
                    or (
                        record.redeemed_tx_hash is not None
                        and not record.redemption_event_emitted
                    )
                )
            )

    async def latest(
        self, merchant_id: str, channel_id: str | None = None
    ) -> tuple[ClaimRecord, ...]:
        async with self._lock:
            return tuple(
                record
                for record in self._records.values()
                if record.merchant_id == merchant_id
                and (channel_id is None or record.channel_id == channel_id)
            )

    async def reserve_redemption(
        self, merchant_id: str, channel_id: str
    ) -> RedemptionReservation:
        async with self._lock:
            record = self._records.get(channel_id)
            if record is None or record.merchant_id != merchant_id:
                return RedemptionReservation(status="missing", record=None)
            if record.redeeming_drops is not None:
                return RedemptionReservation(status="uncertain", record=record)
            if (
                record.redeemed_tx_hash is not None
                and not record.redemption_event_emitted
            ):
                return RedemptionReservation(status="replay", record=record)
            if int(record.cumulative_drops) <= int(record.redeemed_drops):
                return RedemptionReservation(status="replay", record=record)
            reserved = replace(record, redeeming_drops=record.cumulative_drops)
            self._records[channel_id] = reserved
            return RedemptionReservation(status="reserved", record=reserved)

    async def complete_redemption(
        self, channel_id: str, cumulative_drops: str, tx_hash: str
    ) -> bool:
        async with self._lock:
            record = self._records.get(channel_id)
            if record is None or record.redeeming_drops != cumulative_drops:
                return False
            self._records[channel_id] = replace(
                record,
                redeemed_drops=cumulative_drops,
                redeemed_tx_hash=tx_hash,
                redeeming_drops=None,
                redemption_event_emitted=False,
            )
            return True

    async def mark_redemption_event_emitted(
        self, channel_id: str, cumulative_drops: str, tx_hash: str
    ) -> bool:
        async with self._lock:
            record = self._records.get(channel_id)
            if (
                record is None
                or record.redeemed_drops != cumulative_drops
                or record.redeemed_tx_hash != tx_hash
            ):
                return False
            self._records[channel_id] = replace(
                record, redemption_event_emitted=True
            )
            return True


class SQLiteClaimStore:
    """Cross-process atomic highest-claim persistence using `BEGIN IMMEDIATE`."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS paychan_claims (
                  channel_id TEXT PRIMARY KEY,
                  merchant_id TEXT NOT NULL,
                  source TEXT NOT NULL,
                  destination TEXT NOT NULL,
                  cumulative_drops TEXT NOT NULL,
                  signature TEXT NOT NULL,
                  public_key TEXT NOT NULL,
                  acceptance_key TEXT NOT NULL,
                  accepted_count INTEGER NOT NULL CHECK (accepted_count > 0),
                  redeemed_drops TEXT NOT NULL DEFAULT '0',
                  redeemed_tx_hash TEXT,
                  redeeming_drops TEXT,
                  redemption_event_emitted INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS paychan_claims_merchant ON paychan_claims(merchant_id)"
            )
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(paychan_claims)").fetchall()
            }
            if "redeeming_drops" not in columns:
                connection.execute(
                    "ALTER TABLE paychan_claims ADD COLUMN redeeming_drops TEXT"
                )
            if "acceptance_key" not in columns:
                connection.execute(
                    "ALTER TABLE paychan_claims ADD COLUMN acceptance_key TEXT NOT NULL DEFAULT ''"
                )
            if "redemption_event_emitted" not in columns:
                connection.execute(
                    "ALTER TABLE paychan_claims ADD COLUMN redemption_event_emitted INTEGER NOT NULL DEFAULT 0"
                )

    async def accept(
        self,
        *,
        merchant_id: str,
        channel: ChannelState,
        proof: ClaimProof,
        expected_increment_drops: str,
        acceptance_key: str,
    ) -> StoreAcceptance:
        return await asyncio.to_thread(
            self._accept_sync,
            merchant_id,
            channel,
            proof,
            expected_increment_drops,
            acceptance_key,
        )

    def _accept_sync(
        self,
        merchant_id: str,
        channel: ChannelState,
        proof: ClaimProof,
        expected_increment_drops: str,
        acceptance_key: str,
    ) -> StoreAcceptance:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM paychan_claims WHERE channel_id = ?", (proof.channel_id,)
            ).fetchone()
            previous = _record_from_row(row) if row else None
            floor = max(
                int(channel.balance_drops),
                int(previous.cumulative_drops) if previous else 0,
            )
            if previous and int(proof.cumulative_drops) == int(previous.cumulative_drops):
                connection.commit()
                return StoreAcceptance(
                    status=(
                        "replay"
                        if proof.signature == previous.signature
                        and proof.public_key == previous.public_key
                        and acceptance_key == previous.acceptance_key
                        else "conflict"
                    ),
                    record=previous,
                )
            if int(proof.cumulative_drops) <= floor:
                connection.commit()
                record = previous or ClaimRecord(
                    merchant_id=merchant_id,
                    channel_id=proof.channel_id,
                    source=channel.source,
                    destination=channel.destination,
                    cumulative_drops=str(floor),
                    signature="",
                    public_key=proof.public_key,
                    acceptance_key=acceptance_key,
                    accepted_count=0,
                )
                return StoreAcceptance(status="stale", record=record)
            if int(proof.cumulative_drops) != floor + int(expected_increment_drops):
                connection.commit()
                return StoreAcceptance(
                    status="amount_mismatch",
                    record=previous
                    or ClaimRecord(
                        merchant_id=merchant_id,
                        channel_id=proof.channel_id,
                        source=channel.source,
                        destination=channel.destination,
                        cumulative_drops=str(floor),
                        signature="",
                        public_key=proof.public_key,
                        acceptance_key=acceptance_key,
                        accepted_count=0,
                    ),
                )
            count = previous.accepted_count + 1 if previous else 1
            connection.execute(
                """
                INSERT INTO paychan_claims (
                  channel_id, merchant_id, source, destination, cumulative_drops,
                  signature, public_key, acceptance_key, accepted_count, redeemed_drops,
                  redeemed_tx_hash, redeeming_drops, redemption_event_emitted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET
                  merchant_id=excluded.merchant_id,
                  source=excluded.source,
                  destination=excluded.destination,
                  cumulative_drops=excluded.cumulative_drops,
                  signature=excluded.signature,
                  public_key=excluded.public_key,
                  acceptance_key=excluded.acceptance_key,
                  accepted_count=excluded.accepted_count,
                  redeeming_drops=paychan_claims.redeeming_drops,
                  redemption_event_emitted=paychan_claims.redemption_event_emitted
                """,
                (
                    proof.channel_id,
                    merchant_id,
                    channel.source,
                    channel.destination,
                    proof.cumulative_drops,
                    proof.signature,
                    proof.public_key,
                    acceptance_key,
                    count,
                    previous.redeemed_drops if previous else "0",
                    previous.redeemed_tx_hash if previous else None,
                    previous.redeeming_drops if previous else None,
                    previous.redemption_event_emitted if previous else False,
                ),
            )
            row = connection.execute(
                "SELECT * FROM paychan_claims WHERE channel_id = ?", (proof.channel_id,)
            ).fetchone()
            connection.commit()
            assert row is not None
            return StoreAcceptance(status="accepted", record=_record_from_row(row))
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def pending(
        self, merchant_id: str, channel_id: str | None = None
    ) -> tuple[ClaimRecord, ...]:
        records = await self.latest(merchant_id, channel_id)
        return tuple(
            record
            for record in records
            if int(record.cumulative_drops) > int(record.redeemed_drops)
            or (
                record.redeemed_tx_hash is not None
                and not record.redemption_event_emitted
            )
        )

    async def latest(
        self, merchant_id: str, channel_id: str | None = None
    ) -> tuple[ClaimRecord, ...]:
        def read() -> tuple[ClaimRecord, ...]:
            with self._connect() as connection:
                if channel_id is None:
                    rows = connection.execute(
                        "SELECT * FROM paychan_claims WHERE merchant_id = ? ORDER BY channel_id",
                        (merchant_id,),
                    ).fetchall()
                else:
                    rows = connection.execute(
                        "SELECT * FROM paychan_claims WHERE merchant_id = ? AND channel_id = ?",
                        (merchant_id, channel_id),
                    ).fetchall()
                return tuple(_record_from_row(row) for row in rows)

        return await asyncio.to_thread(read)

    async def reserve_redemption(
        self, merchant_id: str, channel_id: str
    ) -> RedemptionReservation:
        return await asyncio.to_thread(
            self._reserve_redemption_sync, merchant_id, channel_id
        )

    def _reserve_redemption_sync(
        self, merchant_id: str, channel_id: str
    ) -> RedemptionReservation:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM paychan_claims WHERE channel_id = ? AND merchant_id = ?",
                (channel_id, merchant_id),
            ).fetchone()
            if row is None:
                connection.commit()
                return RedemptionReservation(status="missing", record=None)
            record = _record_from_row(row)
            if record.redeeming_drops is not None:
                connection.commit()
                return RedemptionReservation(status="uncertain", record=record)
            if (
                record.redeemed_tx_hash is not None
                and not record.redemption_event_emitted
            ):
                connection.commit()
                return RedemptionReservation(status="replay", record=record)
            if int(record.cumulative_drops) <= int(record.redeemed_drops):
                connection.commit()
                return RedemptionReservation(status="replay", record=record)
            cursor = connection.execute(
                """
                UPDATE paychan_claims
                SET redeeming_drops = cumulative_drops
                WHERE channel_id = ? AND merchant_id = ? AND redeeming_drops IS NULL
                """,
                (channel_id, merchant_id),
            )
            if cursor.rowcount != 1:
                connection.rollback()
                return RedemptionReservation(status="uncertain", record=record)
            row = connection.execute(
                "SELECT * FROM paychan_claims WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            connection.commit()
            assert row is not None
            return RedemptionReservation(status="reserved", record=_record_from_row(row))
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def complete_redemption(
        self, channel_id: str, cumulative_drops: str, tx_hash: str
    ) -> bool:
        def update() -> bool:
            with self._connect() as connection:
                cursor = connection.execute(
                    """
                    UPDATE paychan_claims
                    SET redeemed_drops = ?, redeemed_tx_hash = ?, redeeming_drops = NULL,
                        redemption_event_emitted = 0
                    WHERE channel_id = ? AND redeeming_drops = ?
                    """,
                    (cumulative_drops, tx_hash, channel_id, cumulative_drops),
                )
                return cursor.rowcount == 1

        return await asyncio.to_thread(update)

    async def mark_redemption_event_emitted(
        self, channel_id: str, cumulative_drops: str, tx_hash: str
    ) -> bool:
        def update() -> bool:
            with self._connect() as connection:
                cursor = connection.execute(
                    """
                    UPDATE paychan_claims
                    SET redemption_event_emitted = 1
                    WHERE channel_id = ? AND redeemed_drops = ?
                      AND redeemed_tx_hash = ?
                    """,
                    (channel_id, cumulative_drops, tx_hash),
                )
                return cursor.rowcount == 1

        return await asyncio.to_thread(update)

