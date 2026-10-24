import asyncio

import pytest

from validator import SQLiteAtomicNonceStore


KEY_ID = "k" * 43
NONCE = "n" * 86


def test_sqlite_claim_is_atomic_across_store_instances(tmp_path) -> None:
    database = tmp_path / "nonce.sqlite3"
    stores = (SQLiteAtomicNonceStore(database), SQLiteAtomicNonceStore(database))

    async def claim_concurrently() -> list[bool]:
        return await asyncio.gather(
            stores[0].claim(KEY_ID, NONCE, 1_060, 1_000),
            stores[1].claim(KEY_ID, NONCE, 1_060, 1_000),
        )

    assert sorted(asyncio.run(claim_concurrently())) == [False, True]


def test_sqlite_claim_survives_reopen_and_expires_deterministically(tmp_path) -> None:
    database = tmp_path / "nonce.sqlite3"
    first = SQLiteAtomicNonceStore(database)
    assert asyncio.run(first.claim(KEY_ID, NONCE, 1_060, 1_000)) is True

    reopened = SQLiteAtomicNonceStore(database)
    assert asyncio.run(reopened.claim(KEY_ID, NONCE, 1_070, 1_001)) is False
    assert asyncio.run(reopened.claim(KEY_ID, NONCE, 1_120, 1_060)) is True


@pytest.mark.parametrize(
    "arguments",
    [
        ("", NONCE, 1_060, 1_000),
        (KEY_ID, "", 1_060, 1_000),
        (KEY_ID, NONCE, 1_000, 1_000),
        (KEY_ID, NONCE, True, 1_000),
    ],
)
def test_sqlite_claim_rejects_invalid_boundaries(tmp_path, arguments) -> None:
    store = SQLiteAtomicNonceStore(tmp_path / "nonce.sqlite3")
    with pytest.raises(ValueError, match="nonce claim is invalid"):
        asyncio.run(store.claim(*arguments))


@pytest.mark.parametrize("timeout", [0, 0.01, 5.01, True])
def test_sqlite_store_rejects_unsafe_timeouts(tmp_path, timeout) -> None:
    with pytest.raises(ValueError, match="timeout"):
        SQLiteAtomicNonceStore(tmp_path / "nonce.sqlite3", timeout_seconds=timeout)
