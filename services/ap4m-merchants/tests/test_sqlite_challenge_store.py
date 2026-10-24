import asyncio
from dataclasses import replace

import pytest

from app.catalog import merchant, product
from app.validator.challenge import (
    ChallengeLease,
    ChallengeStateError,
    InMemoryMockChallengeStore,
    SQLiteChallengeStore,
)


TX_HASH = "A" * 64
INTENT_ID = "demo-intent-recovery"
MERCHANT_RESULT = {
    "data": {"schema_id": "yield_report_v1", "apr_percent": "4.25"},
    "intent_validation": {
        "intentId": INTENT_ID,
        "validated": True,
        "validation_errors": [],
    },
}


def test_sqlite_challenge_survives_reopen_and_round_trips(tmp_path) -> None:
    now = 1_795_000_000
    database = tmp_path / "challenges.sqlite3"
    first = SQLiteChallengeStore(database, now=lambda: now)
    state_id, expected = first.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(first.publish(expected))

    reopened = SQLiteChallengeStore(database, now=lambda: now + 1)
    assert asyncio.run(reopened.get(state_id)) == expected


def test_sqlite_acquire_is_atomic_across_store_instances(tmp_path) -> None:
    now = 1_795_000_000
    database = tmp_path / "challenges.sqlite3"
    stores = (
        SQLiteChallengeStore(database, now=lambda: now),
        SQLiteChallengeStore(database, now=lambda: now),
    )
    state_id, context = stores[0].prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(stores[0].publish(context))

    async def acquire_concurrently() -> list[object]:
        return await asyncio.gather(
            stores[0].acquire(state_id),
            stores[1].acquire(state_id),
            return_exceptions=True,
        )

    results = asyncio.run(acquire_concurrently())
    successes = [result for result in results if result == context]
    failures = [result for result in results if isinstance(result, ChallengeStateError)]
    assert successes == [context]
    assert len(failures) == 1
    assert failures[0].code == "CHALLENGE_STATE_IN_FLIGHT"

    asyncio.run(stores[1].release(state_id))
    assert asyncio.run(stores[1].acquire(state_id)) == context
    asyncio.run(stores[1].consume(state_id))
    with pytest.raises(ChallengeStateError, match="missing or expired"):
        asyncio.run(stores[0].get(state_id))


def test_sqlite_expiry_and_capacity_are_atomic(tmp_path) -> None:
    clock = [1_795_000_000]
    store = SQLiteChallengeStore(
        tmp_path / "challenges.sqlite3",
        now=lambda: clock[0],
        ttl_seconds=2,
        max_entries=1,
    )
    _, first = store.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    _, second = store.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(store.publish(first))
    with pytest.raises(ChallengeStateError) as full:
        asyncio.run(store.publish(second))
    assert full.value.code == "CHALLENGE_STORE_FULL"

    clock[0] += 2
    asyncio.run(store.publish(second))
    with pytest.raises(ChallengeStateError) as expired:
        asyncio.run(store.get(first.state_id))
    assert expired.value.code == "CHALLENGE_STATE_EXPIRED"


def test_sqlite_rejects_collision_and_corrupt_context(tmp_path) -> None:
    now = 1_795_000_000
    store = SQLiteChallengeStore(tmp_path / "challenges.sqlite3", now=lambda: now)
    state_id, context = store.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(store.publish(context))
    with pytest.raises(ChallengeStateError) as collision:
        asyncio.run(store.publish(replace(context, merchant_id="different")))
    assert collision.value.code == "CHALLENGE_STATE_COLLISION"

    connection = store._connect()
    try:
        connection.execute(
            "UPDATE ap4m_challenges SET context_json = ? WHERE state_id = ?",
            ('{"state_id":"attacker"}', state_id),
        )
    finally:
        connection.close()
    with pytest.raises(ChallengeStateError) as corrupt:
        asyncio.run(store.get(state_id))
    assert corrupt.value.code == "CHALLENGE_STATE_CORRUPT"


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_completed_challenge_recovers_only_exact_retry(tmp_path, kind) -> None:
    now = 1_795_000_000
    if kind == "memory":
        store = InMemoryMockChallengeStore(now=lambda: now)
    else:
        store = SQLiteChallengeStore(
            tmp_path / "challenges.sqlite3", now=lambda: now
        )
    state_id, context = store.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(store.publish(context))
    asyncio.run(store.acquire(state_id))
    asyncio.run(store.complete(state_id, INTENT_ID, TX_HASH, MERCHANT_RESULT))

    recovered = asyncio.run(store.recover(state_id, INTENT_ID, TX_HASH))
    assert recovered == MERCHANT_RESULT
    assert recovered is not MERCHANT_RESULT
    assert asyncio.run(store.completed_context(state_id)) == context
    # Completion is idempotent only for the exact same persisted response.
    asyncio.run(store.complete(state_id, INTENT_ID, TX_HASH, MERCHANT_RESULT))

    for intent_id, tx_hash in (
        ("demo-intent-different", TX_HASH),
        (INTENT_ID, "B" * 64),
    ):
        with pytest.raises(ChallengeStateError) as mismatch:
            asyncio.run(store.recover(state_id, intent_id, tx_hash))
        assert mismatch.value.code == "CHALLENGE_REPLAY_MISMATCH"
    with pytest.raises(ChallengeStateError) as wrong_state:
        asyncio.run(store.recover("x" * 43, INTENT_ID, TX_HASH))
    assert wrong_state.value.code == "CHALLENGE_REPLAY_MISMATCH"


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_completion_requires_acquire_and_rejects_sensitive_cache(tmp_path, kind) -> None:
    now = 1_795_000_000
    if kind == "memory":
        store = InMemoryMockChallengeStore(now=lambda: now)
    else:
        store = SQLiteChallengeStore(
            tmp_path / "challenges.sqlite3", now=lambda: now
        )
    state_id, context = store.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(store.publish(context))
    with pytest.raises(ChallengeStateError) as not_acquired:
        asyncio.run(store.complete(state_id, INTENT_ID, TX_HASH, MERCHANT_RESULT))
    assert not_acquired.value.code == "CHALLENGE_STATE_NOT_ACQUIRED"

    asyncio.run(store.acquire(state_id))
    with pytest.raises(ChallengeStateError) as secret:
        asyncio.run(
            store.complete(
                state_id,
                INTENT_ID,
                TX_HASH,
                {"data": {"signedTxBlob": "DEADBEEF"}},
            )
        )
    assert secret.value.code == "CHALLENGE_RESULT_INVALID"


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_fenced_lease_stale_takeover_preserves_checkpoint(tmp_path, kind) -> None:
    clock = [1_795_000_000]
    if kind == "memory":
        store = InMemoryMockChallengeStore(now=lambda: clock[0], lease_seconds=5)
    else:
        store = SQLiteChallengeStore(
            tmp_path / "challenges.sqlite3",
            now=lambda: clock[0],
            lease_seconds=5,
        )
    state_id, context = store.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(store.publish(context))
    first = asyncio.run(store.acquire_fenced(state_id, INTENT_ID, TX_HASH))
    asyncio.run(store.checkpoint(first, MERCHANT_RESULT))

    with pytest.raises(ChallengeStateError) as checkpoint_mismatch:
        asyncio.run(
            store.complete(
                state_id,
                INTENT_ID,
                TX_HASH,
                {"data": {"schema_id": "different"}},
                first.owner_token,
            )
        )
    assert checkpoint_mismatch.value.code == "CHALLENGE_CHECKPOINT_MISMATCH"

    with pytest.raises(ChallengeStateError) as concurrent:
        asyncio.run(store.acquire_fenced(state_id, INTENT_ID, TX_HASH))
    assert concurrent.value.code == "CHALLENGE_STATE_IN_FLIGHT"
    forged = ChallengeLease(
        context,
        "x" * 43,
        INTENT_ID,
        TX_HASH,
        MERCHANT_RESULT,
    )
    with pytest.raises(ChallengeStateError) as non_owner:
        asyncio.run(store.checkpoint(forged, MERCHANT_RESULT))
    assert non_owner.value.code == "CHALLENGE_LEASE_NOT_OWNER"

    clock[0] += 5
    takeover = asyncio.run(store.acquire_fenced(state_id, INTENT_ID, TX_HASH))
    assert takeover.owner_token != first.owner_token
    assert takeover.checkpoint == MERCHANT_RESULT
    asyncio.run(
        store.complete(
            state_id,
            INTENT_ID,
            TX_HASH,
            takeover.checkpoint,
            takeover.owner_token,
        )
    )
    assert asyncio.run(store.recover(state_id, INTENT_ID, TX_HASH)) == MERCHANT_RESULT


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_fenced_lease_rejects_key_change_on_takeover(tmp_path, kind) -> None:
    clock = [1_795_000_000]
    if kind == "memory":
        store = InMemoryMockChallengeStore(now=lambda: clock[0], lease_seconds=1)
    else:
        store = SQLiteChallengeStore(
            tmp_path / "challenges.sqlite3",
            now=lambda: clock[0],
            lease_seconds=1,
        )
    state_id, context = store.prepare(
        merchant("venue-yield-desk"), product("venue-yield-desk", "yield-report")
    )
    asyncio.run(store.publish(context))
    asyncio.run(store.acquire_fenced(state_id, INTENT_ID, TX_HASH))
    clock[0] += 1
    with pytest.raises(ChallengeStateError) as mismatch:
        asyncio.run(
            store.acquire_fenced(
                state_id,
                "demo-intent-different",
                TX_HASH,
            )
        )
    assert mismatch.value.code == "CHALLENGE_REPLAY_MISMATCH"


@pytest.mark.parametrize("timeout", [0, 0.01, 5.01, True])
def test_sqlite_challenge_rejects_unsafe_timeouts(tmp_path, timeout) -> None:
    with pytest.raises(ValueError, match="timeout"):
        SQLiteChallengeStore(
            tmp_path / "challenges.sqlite3", now=lambda: 1, timeout_seconds=timeout
        )
