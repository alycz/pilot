"""Durable atomic Web Bot Auth nonce storage for a single shared host."""

import asyncio
import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SQLiteAtomicNonceStore:
    """SQLite-backed atomic nonce claims shared by local worker processes.

    The database path is injected by the application. SQLite transactions make
    claims atomic for workers sharing that file; deployments without a shared
    filesystem must inject a different implementation of the ``NonceStore``
    protocol.
    """

    database_path: str | Path
    timeout_seconds: float = 2.0

    def __post_init__(self) -> None:
        if not isinstance(self.database_path, (str, Path)) or not str(
            self.database_path
        ):
            raise ValueError("durable nonce database must be a filesystem path")
        path = Path(self.database_path)
        if str(path) == ":memory:":
            raise ValueError("durable nonce database must be a filesystem path")
        if not isinstance(self.timeout_seconds, (int, float)) or isinstance(
            self.timeout_seconds, bool
        ):
            raise ValueError("nonce database timeout is invalid")
        if not 0.05 <= self.timeout_seconds <= 5.0:
            raise ValueError("nonce database timeout must be between 0.05 and 5 seconds")
        object.__setattr__(self, "database_path", path)
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
                CREATE TABLE IF NOT EXISTS wba_nonce_claims (
                    keyid TEXT NOT NULL,
                    nonce TEXT NOT NULL,
                    expires INTEGER NOT NULL,
                    PRIMARY KEY (keyid, nonce)
                ) WITHOUT ROWID
                """
            )
        finally:
            connection.close()

    async def claim(self, keyid: str, nonce: str, expires: int, now: int) -> bool:
        if (
            not isinstance(keyid, str)
            or not keyid
            or len(keyid) > 128
            or not isinstance(nonce, str)
            or not nonce
            or len(nonce) > 256
            or not isinstance(expires, int)
            or isinstance(expires, bool)
            or not isinstance(now, int)
            or isinstance(now, bool)
            or now < 0
            or expires <= now
        ):
            raise ValueError("nonce claim is invalid")
        return await asyncio.to_thread(self._claim_sync, keyid, nonce, expires, now)

    def _claim_sync(self, keyid: str, nonce: str, expires: int, now: int) -> bool:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM wba_nonce_claims WHERE expires <= ?", (now,))
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO wba_nonce_claims (keyid, nonce, expires)
                VALUES (?, ?, ?)
                """,
                (keyid, nonce, expires),
            )
            connection.commit()
            return cursor.rowcount == 1
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
