from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from .verifier import MAX_TX_SEARCH_LEDGER_COUNT, VerificationReceipt


VERIFY_LEASE_SECONDS = 10.0
MAX_ACTIVE_INVOICES = 128
MAX_TOTAL_INVOICES = 512
WAL_AUTOCHECKPOINT_PAGES = 64
WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024


class InvoiceCapacityError(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Invoice:
    invoice_id: str
    resource: Mapping[str, Any]
    requirement: Mapping[str, Any]
    issued_at: float
    expires_at: float
    first_ledger_sequence: Optional[int]
    state: str
    signature_hash: Optional[str]
    claimed_at: Optional[float]
    claim_generation: int
    verified_receipt: Optional[VerificationReceipt]
    settlement_started_at: Optional[float]
    terminal_ledger_index: Optional[int]
    response_body: Optional[Mapping[str, Any]]
    payment_response: Optional[str]


@dataclass(frozen=True)
class ClaimResult:
    outcome: str
    invoice: Invoice


@dataclass(frozen=True)
class TransitionResult:
    outcome: str
    invoice: Invoice


class InvoiceStore:
    def __init__(
        self,
        path: Path,
        clock: Callable[[], float],
        *,
        max_active_invoices: int = MAX_ACTIVE_INVOICES,
        max_total_invoices: int = MAX_TOTAL_INVOICES,
    ) -> None:
        if max_active_invoices <= 0 or max_total_invoices <= 0:
            raise ValueError("invoice quotas must be positive")
        if max_active_invoices > max_total_invoices:
            raise ValueError("active invoice quota cannot exceed total invoice quota")
        self._path = self._prepare_path(path)
        self._clock = clock
        self._max_active_invoices = max_active_invoices
        self._max_total_invoices = max_total_invoices
        self._initialize()
        os.chmod(self._path, 0o600)

    @staticmethod
    def _prepare_path(path: Path) -> Path:
        path = path.absolute()
        if path.exists() and path.is_symlink():
            raise ValueError("invoice database must not be a symlink")
        parent = path.parent
        if parent.exists() and parent.is_symlink():
            raise ValueError("invoice database directory must not be a symlink")
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if parent.is_symlink():
            raise ValueError("invoice database directory must not be a symlink")
        if path.exists() and path.is_symlink():
            raise ValueError("invoice database must not be a symlink")
        if hasattr(os, "getuid"):
            owner = os.getuid()
            if parent.stat().st_uid != owner:
                raise ValueError("invoice database directory must be owned by this user")
            if path.exists() and path.stat().st_uid != owner:
                raise ValueError("invoice database must be owned by this user")
        try:
            os.chmod(parent, 0o700)
        except OSError:
            pass
        return path

    def _connect(self) -> sqlite3.Connection:
        if self._path.is_symlink():
            raise ValueError("invoice database must not be a symlink")
        connection = sqlite3.connect(str(self._path), timeout=5.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _create_table(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS x402_invoices (
                invoice_id TEXT PRIMARY KEY,
                resource_json TEXT NOT NULL,
                requirement_json TEXT NOT NULL,
                issued_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                first_ledger_sequence INTEGER,
                state TEXT NOT NULL CHECK(state IN ('pending', 'verifying', 'settling', 'delivered', 'not_included')),
                signature_hash TEXT,
                claimed_at REAL,
                claim_generation INTEGER NOT NULL DEFAULT 0,
                verified_receipt_json TEXT,
                settlement_started_at REAL,
                terminal_ledger_index INTEGER,
                response_json TEXT,
                payment_response TEXT
            )
            """
        )

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(f"PRAGMA wal_autocheckpoint={WAL_AUTOCHECKPOINT_PAGES}")
            connection.execute(f"PRAGMA journal_size_limit={WAL_SIZE_LIMIT_BYTES}")
            self._create_table(connection)
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(x402_invoices)").fetchall()
            }
            table_sql_row = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'x402_invoices'"
            ).fetchone()
            assert table_sql_row is not None
            required = {
                "claimed_at",
                "claim_generation",
                "verified_receipt_json",
                "settlement_started_at",
                "terminal_ledger_index",
                "first_ledger_sequence",
            }
            if "'not_included'" not in table_sql_row["sql"] or not required.issubset(columns):
                claimed = "claimed_at" if "claimed_at" in columns else "NULL"
                generation = "claim_generation" if "claim_generation" in columns else "0"
                verified = (
                    "verified_receipt_json" if "verified_receipt_json" in columns else "NULL"
                )
                started = (
                    "settlement_started_at" if "settlement_started_at" in columns else "NULL"
                )
                terminal_ledger = (
                    "terminal_ledger_index"
                    if "terminal_ledger_index" in columns
                    else "NULL"
                )
                first_ledger = (
                    "first_ledger_sequence"
                    if "first_ledger_sequence" in columns
                    else "NULL"
                )
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "ALTER TABLE x402_invoices RENAME TO x402_invoices_legacy"
                )
                self._create_table(connection)
                connection.execute(
                    f"""
                    INSERT INTO x402_invoices (
                        invoice_id, resource_json, requirement_json, issued_at,
                        expires_at, first_ledger_sequence, state,
                        signature_hash, claimed_at,
                        claim_generation, verified_receipt_json,
                        settlement_started_at, terminal_ledger_index,
                        response_json, payment_response
                    )
                    SELECT invoice_id, resource_json, requirement_json, issued_at,
                           expires_at, {first_ledger}, state, signature_hash,
                           {claimed}, {generation},
                           {verified}, {started}, {terminal_ledger},
                           response_json, payment_response
                    FROM x402_invoices_legacy
                    """
                )
                connection.execute("DROP TABLE x402_invoices_legacy")
                connection.execute("COMMIT")

    @staticmethod
    def _decode(row: sqlite3.Row) -> Invoice:
        response = json.loads(row["response_json"]) if row["response_json"] else None
        receipt_json = (
            json.loads(row["verified_receipt_json"])
            if row["verified_receipt_json"]
            else None
        )
        return Invoice(
            invoice_id=row["invoice_id"],
            resource=json.loads(row["resource_json"]),
            requirement=json.loads(row["requirement_json"]),
            issued_at=row["issued_at"],
            expires_at=row["expires_at"],
            first_ledger_sequence=row["first_ledger_sequence"],
            state=row["state"],
            signature_hash=row["signature_hash"],
            claimed_at=row["claimed_at"],
            claim_generation=row["claim_generation"],
            verified_receipt=(
                VerificationReceipt(**receipt_json) if receipt_json else None
            ),
            settlement_started_at=row["settlement_started_at"],
            terminal_ledger_index=row["terminal_ledger_index"],
            response_body=response,
            payment_response=row["payment_response"],
        )

    @staticmethod
    def _select(connection: sqlite3.Connection, invoice_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM x402_invoices WHERE invoice_id = ?", (invoice_id,)
        ).fetchone()
        if row is None:
            raise KeyError(invoice_id)
        return row

    @staticmethod
    def _same_offer(
        invoice: Invoice,
        resource: Mapping[str, Any],
        requirement: Mapping[str, Any],
    ) -> bool:
        if invoice.resource != resource:
            return False
        stored = json.loads(json.dumps(invoice.requirement))
        candidate = json.loads(json.dumps(requirement))
        stored_extra = stored.get("extra")
        candidate_extra = candidate.get("extra")
        if not isinstance(stored_extra, dict) or not isinstance(candidate_extra, dict):
            return False
        stored_extra.pop("invoiceId", None)
        candidate_extra.pop("invoiceId", None)
        return stored == candidate

    def put_or_reuse(
        self,
        invoice_id: str,
        resource: Mapping[str, Any],
        requirement: Mapping[str, Any],
        ttl_seconds: int,
        first_ledger_sequence: Optional[int] = None,
    ) -> Optional[Invoice]:
        if first_ledger_sequence is not None and first_ledger_sequence <= 0:
            raise ValueError("first ledger sequence must be positive")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = self._clock()
            connection.execute(
                """
                DELETE FROM x402_invoices
                WHERE state = 'pending' AND signature_hash IS NULL AND expires_at <= ?
                """,
                (now,),
            )
            reusable_rows = connection.execute(
                """
                SELECT * FROM x402_invoices
                WHERE state = 'pending' AND signature_hash IS NULL AND expires_at > ?
                ORDER BY issued_at DESC
                """,
                (now,),
            ).fetchall()
            for reusable_row in reusable_rows:
                reusable = self._decode(reusable_row)
                if self._same_offer(reusable, resource, requirement):
                    connection.execute("COMMIT")
                    return reusable
            total = connection.execute(
                "SELECT COUNT(*) AS count FROM x402_invoices"
            ).fetchone()["count"]
            if total >= self._max_total_invoices:
                connection.execute("COMMIT")
                raise InvoiceCapacityError("history_capacity_reached")
            active = connection.execute(
                """
                SELECT COUNT(*) AS count FROM x402_invoices
                WHERE state IN ('pending', 'verifying') AND expires_at > ?
                """,
                (now,),
            ).fetchone()["count"]
            if active >= self._max_active_invoices:
                connection.execute("COMMIT")
                raise InvoiceCapacityError("active_capacity_reached")
            connection.execute(
                """
                INSERT INTO x402_invoices (
                    invoice_id, resource_json, requirement_json, issued_at,
                    expires_at, first_ledger_sequence, state
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
                """,
                (
                    invoice_id,
                    json.dumps(resource, separators=(",", ":"), sort_keys=True),
                    json.dumps(requirement, separators=(",", ":"), sort_keys=True),
                    now,
                    now + ttl_seconds,
                    first_ledger_sequence,
                ),
            )
            row = self._select(connection, invoice_id)
            connection.execute("COMMIT")
        return self._decode(row)

    def put(
        self,
        invoice_id: str,
        resource: Mapping[str, Any],
        requirement: Mapping[str, Any],
        ttl_seconds: int,
        first_ledger_sequence: Optional[int] = None,
    ) -> Invoice:
        invoice = self.put_or_reuse(
            invoice_id,
            resource,
            requirement,
            ttl_seconds,
            first_ledger_sequence,
        )
        if invoice is None or invoice.invoice_id != invoice_id:
            raise RuntimeError("invoice quota or reusable invoice prevented insert")
        return invoice

    def get(self, invoice_id: str) -> Optional[Invoice]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM x402_invoices WHERE invoice_id = ?", (invoice_id,)
            ).fetchone()
        return self._decode(row) if row is not None else None

    def claim(self, invoice_id: str, signature_hash: str) -> ClaimResult:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = self._clock()
            invoice = self._decode(self._select(connection, invoice_id))
            if invoice.state == "delivered":
                outcome = "cached" if invoice.signature_hash == signature_hash else "conflict"
            elif invoice.state == "not_included":
                outcome = (
                    "not_included"
                    if invoice.signature_hash == signature_hash
                    else "conflict"
                )
            elif invoice.state == "settling":
                outcome = "reconcile" if invoice.signature_hash == signature_hash else "conflict"
            elif invoice.state == "verifying":
                if invoice.signature_hash != signature_hash:
                    outcome = "conflict"
                elif now >= invoice.expires_at:
                    outcome = "expired"
                elif (
                    invoice.claimed_at is not None
                    and now - invoice.claimed_at >= VERIFY_LEASE_SECONDS
                ):
                    cursor = connection.execute(
                        """
                        UPDATE x402_invoices
                        SET claimed_at = ?, claim_generation = claim_generation + 1
                        WHERE invoice_id = ? AND state = 'verifying'
                          AND signature_hash = ? AND claim_generation = ?
                        """,
                        (now, invoice_id, signature_hash, invoice.claim_generation),
                    )
                    if cursor.rowcount != 1:
                        connection.execute("ROLLBACK")
                        raise RuntimeError("invoice claim compare-and-swap failed")
                    invoice = self._decode(self._select(connection, invoice_id))
                    outcome = "claimed"
                else:
                    outcome = "in_progress"
            elif now >= invoice.expires_at:
                outcome = "expired"
            else:
                cursor = connection.execute(
                    """
                    UPDATE x402_invoices
                    SET state = 'verifying', signature_hash = ?, claimed_at = ?,
                        claim_generation = claim_generation + 1
                    WHERE invoice_id = ? AND state = 'pending'
                    """,
                    (signature_hash, now, invoice_id),
                )
                if cursor.rowcount != 1:
                    connection.execute("ROLLBACK")
                    raise RuntimeError("invoice claim compare-and-swap failed")
                invoice = self._decode(self._select(connection, invoice_id))
                outcome = "claimed"
            connection.execute("COMMIT")
        return ClaimResult(outcome=outcome, invoice=invoice)

    def release(
        self, invoice_id: str, signature_hash: str, claim_generation: int
    ) -> bool:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                """
                UPDATE x402_invoices
                SET state = 'pending', signature_hash = NULL, claimed_at = NULL
                WHERE invoice_id = ? AND state = 'verifying'
                  AND signature_hash = ? AND claim_generation = ?
                """,
                (invoice_id, signature_hash, claim_generation),
            )
            connection.execute("COMMIT")
        return cursor.rowcount == 1

    def mark_settling(
        self,
        invoice_id: str,
        signature_hash: str,
        claim_generation: int,
        receipt: VerificationReceipt,
    ) -> TransitionResult:
        with self._connect() as connection:
            current = self._decode(self._select(connection, invoice_id))
        if current.first_ledger_sequence is not None:
            ledger_count = (
                receipt.last_ledger_sequence - current.first_ledger_sequence + 1
            )
            if not 1 <= ledger_count <= MAX_TX_SEARCH_LEDGER_COUNT:
                raise RuntimeError("invoice ledger search window rejected")
        receipt_json = json.dumps(asdict(receipt), separators=(",", ":"), sort_keys=True)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = self._clock()
            cursor = connection.execute(
                """
                UPDATE x402_invoices
                SET state = 'settling', verified_receipt_json = ?,
                    settlement_started_at = ?
                WHERE invoice_id = ? AND state = 'verifying'
                  AND signature_hash = ? AND claim_generation = ?
                  AND expires_at > ?
                """,
                (
                    receipt_json,
                    now,
                    invoice_id,
                    signature_hash,
                    claim_generation,
                    now,
                ),
            )
            invoice = self._decode(self._select(connection, invoice_id))
            if cursor.rowcount == 1:
                outcome = "settling"
            elif invoice.expires_at <= now and invoice.state == "verifying":
                outcome = "expired"
            else:
                outcome = "claim_lost"
            connection.execute("COMMIT")
        return TransitionResult(outcome=outcome, invoice=invoice)

    def mark_not_included(
        self,
        invoice_id: str,
        signature_hash: str,
        transaction_hash: str,
        validated_ledger_index: int,
    ) -> Invoice:
        if validated_ledger_index <= 0:
            raise ValueError("validated ledger index must be positive")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = self._decode(self._select(connection, invoice_id))
            if (
                current.state == "not_included"
                and current.signature_hash == signature_hash
                and current.verified_receipt is not None
                and current.verified_receipt.transaction == transaction_hash
                and current.terminal_ledger_index is not None
            ):
                connection.execute("COMMIT")
                return current
            if (
                current.state != "settling"
                or current.signature_hash != signature_hash
                or current.verified_receipt is None
                or current.verified_receipt.transaction != transaction_hash
                or current.verified_receipt.last_ledger_sequence <= 0
                or validated_ledger_index
                <= current.verified_receipt.last_ledger_sequence
            ):
                connection.execute("ROLLBACK")
                raise RuntimeError("invoice terminal transition rejected")
            cursor = connection.execute(
                """
                UPDATE x402_invoices
                SET state = 'not_included', terminal_ledger_index = ?
                WHERE invoice_id = ? AND state = 'settling'
                  AND signature_hash = ?
                """,
                (
                    validated_ledger_index,
                    invoice_id,
                    signature_hash,
                ),
            )
            if cursor.rowcount != 1:
                connection.execute("ROLLBACK")
                raise RuntimeError("invoice terminal transition rejected")
            invoice = self._decode(self._select(connection, invoice_id))
            connection.execute("COMMIT")
        return invoice

    def complete(
        self,
        invoice_id: str,
        signature_hash: str,
        transaction_hash: str,
        response_body: Mapping[str, Any],
        payment_response: str,
    ) -> Invoice:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            invoice = self._decode(self._select(connection, invoice_id))
            if invoice.state == "delivered" and invoice.signature_hash == signature_hash:
                connection.execute("COMMIT")
                return invoice
            if (
                invoice.state != "settling"
                or invoice.signature_hash != signature_hash
                or invoice.verified_receipt is None
                or invoice.verified_receipt.transaction != transaction_hash
            ):
                connection.execute("ROLLBACK")
                raise RuntimeError("invoice completion rejected")
            cursor = connection.execute(
                """
                UPDATE x402_invoices
                SET state = 'delivered', response_json = ?, payment_response = ?
                WHERE invoice_id = ? AND state = 'settling'
                  AND signature_hash = ?
                """,
                (
                    json.dumps(response_body, separators=(",", ":"), sort_keys=True),
                    payment_response,
                    invoice_id,
                    signature_hash,
                ),
            )
            if cursor.rowcount != 1:
                connection.execute("ROLLBACK")
                raise RuntimeError("invoice completion rejected")
            invoice = self._decode(self._select(connection, invoice_id))
            connection.execute("COMMIT")
        return invoice
