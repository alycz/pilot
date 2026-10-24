"""Offline MM3 claim verification, persistence, and redemption tests."""

import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, utils

from paychan import (
    ChannelState,
    ClaimProof,
    InMemoryClaimStore,
    LocalVerifierUnavailable,
    PaychanDependencies,
    PaychanFailure,
    PaychanRuntime,
    SQLiteClaimStore,
    SubmissionResult,
    signing_claim_bytes,
    verify_claim_signature,
)


CHANNEL = "AB" * 32
SOURCE = "rSource"
DESTINATION = "rMerchant"
PUBLIC_KEY = "02" + "11" * 32
SIGNATURE = "30"
TX_HASH = "CD" * 32
PRICE_DROPS = "50000"


class Reader:
    def __init__(self, channel: ChannelState | None) -> None:
        self.channel = channel

    async def read_channel(self, channel_id: str) -> ChannelState | None:
        return self.channel


class Credentials:
    def __init__(self, accepted: bool = True) -> None:
        self.accepted = accepted

    async def accepted_source(self, source: str) -> bool:
        return self.accepted


class RippledVerifier:
    def __init__(self, result: bool = True) -> None:
        self.result = result
        self.calls: list[tuple[str, str, str, str]] = []

    async def channel_verify(
        self,
        channel_id: str,
        cumulative_drops: str,
        signature: str,
        public_key: str,
    ) -> bool:
        self.calls.append((channel_id, cumulative_drops, signature, public_key))
        return self.result


class Submitter:
    def __init__(self, result: SubmissionResult | Exception | None = None) -> None:
        self.result = result or SubmissionResult(TX_HASH, True, "tesSUCCESS")
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.entered: asyncio.Event | None = None
        self.release: asyncio.Event | None = None

    async def submit_payment_channel_claim(
        self, merchant_id: str, transaction: dict[str, str]
    ) -> SubmissionResult:
        self.calls.append((merchant_id, transaction))
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            await self.release.wait()
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def channel(**changes: object) -> ChannelState:
    return replace(
        ChannelState(
            channel_id=CHANNEL,
            source=SOURCE,
            destination=DESTINATION,
            amount_drops="1000000",
            balance_drops="0",
            public_key=PUBLIC_KEY,
            settle_delay_seconds=3600,
            expiration_ripple=10000,
            cancel_after_ripple=20000,
        ),
        **changes,
    )


def proof(cumulative: str = PRICE_DROPS, **changes: object) -> ClaimProof:
    return replace(
        ClaimProof(
            channel_id=CHANNEL,
            cumulative_drops=cumulative,
            signature=SIGNATURE,
            public_key=PUBLIC_KEY,
        ),
        **changes,
    )


def runtime(
    *,
    state: ChannelState | None = None,
    accepted: bool = True,
    store=None,
    local_verifier=lambda _proof: True,
    rippled_verifier=None,
    submitter=None,
    event_sink=None,
    auto_settle_every=None,
) -> PaychanRuntime:
    return PaychanRuntime(
        PaychanDependencies(
            channel_reader=Reader(state if state is not None else channel()),
            credential_reader=Credentials(accepted),
            store=store or InMemoryClaimStore(),
            now_ripple=lambda: 100,
            local_verifier=local_verifier,
            rippled_verifier=rippled_verifier,
            submitter=submitter,
            event_sink=event_sink,
            auto_settle_every=auto_settle_every,
        )
    )


def accept(
    service: PaychanRuntime,
    claim: ClaimProof | None = None,
    *,
    expected: str = PRICE_DROPS,
    payer: str = SOURCE,
):
    return asyncio.run(
        service.accept_claim(
            "merchant",
            DESTINATION,
            claim or proof(),
            credentialed_payer=payer,
            expected_increment_drops=expected,
            acceptance_key="state-1",
        )
    )


def failure_code(call) -> str:
    with pytest.raises(PaychanFailure) as caught:
        call()
    return caught.value.code


def test_retry_key_is_strict_domain_separated_stable_and_change_sensitive() -> None:
    payment = {
        "type": "xrpl_paychan_claim",
        "channel_id": CHANNEL.lower(),
        "cumulative_drops": PRICE_DROPS,
        "signature": SIGNATURE.lower(),
        "public_key": PUBLIC_KEY.lower(),
    }
    first = PaychanRuntime.retry_key(payment)
    assert first == PaychanRuntime.retry_key(dict(payment))
    assert len(first) == 64 and first == first.upper()
    assert first != PaychanRuntime.retry_key({**payment, "cumulative_drops": "50001"})
    for malformed in (
        {key: value for key, value in payment.items() if key != "signature"},
        {**payment, "extra": "x"},
        {**payment, "type": "xrpl_exact"},
    ):
        assert failure_code(lambda malformed=malformed: PaychanRuntime.retry_key(malformed)) == (
            "PAYCHAN_PROOF_INVALID"
        )
    assert failure_code(
        lambda: PaychanRuntime.retry_key({**payment, "cumulative_drops": "9" * 5000})
    ) == "PAYCHAN_PROOF_INVALID"
    assert failure_code(
        lambda: PaychanRuntime.retry_key({**payment, "signature": "AA" * 73})
    ) == "PAYCHAN_PROOF_INVALID"


def test_local_secp256k1_and_ed25519_claim_signatures_verify() -> None:
    message = signing_claim_bytes(CHANNEL, PRICE_DROPS)

    secp_private = ec.generate_private_key(ec.SECP256K1())
    digest = __import__("hashlib").sha512(message).digest()[:32]
    signature = secp_private.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    r, s = utils.decode_dss_signature(signature)
    order = int("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16)
    if s > order // 2:
        signature = utils.encode_dss_signature(r, order - s)
    secp_public = secp_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint
    )
    assert verify_claim_signature(
        ClaimProof(CHANNEL, PRICE_DROPS, signature.hex(), secp_public.hex())
    )

    ed_private = ed25519.Ed25519PrivateKey.generate()
    ed_public = ed_private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    assert verify_claim_signature(
        ClaimProof(
            CHANNEL,
            PRICE_DROPS,
            ed_private.sign(message).hex(),
            "ED" + ed_public.hex(),
        )
    )


@pytest.mark.parametrize(
    ("service", "claim", "payer", "code"),
    [
        (runtime(state=channel(destination="rOther")), proof(), SOURCE, "PAYCHAN_DESTINATION_MISMATCH"),
        (runtime(), proof(), "rOther", "PAYCHAN_SOURCE_MISMATCH"),
        (runtime(accepted=False), proof(), SOURCE, "PAYCHAN_CREDENTIAL_NOT_ACCEPTED"),
        (runtime(state=channel(public_key="03" + "22" * 32)), proof(), SOURCE, "PAYCHAN_PUBLIC_KEY_MISMATCH"),
        (runtime(state=channel(balance_drops=PRICE_DROPS)), proof(), SOURCE, "PAYCHAN_CLAIM_NOT_INCREASING"),
        (runtime(state=channel(amount_drops="49999")), proof(), SOURCE, "PAYCHAN_AMOUNT_EXCEEDED"),
        (runtime(state=channel(expiration_ripple=3700)), proof(), SOURCE, "PAYCHAN_CLOSING_SOON"),
        (runtime(local_verifier=lambda _proof: False), proof(), SOURCE, "PAYCHAN_SIGNATURE_INVALID"),
    ],
)
def test_claim_rejection_branches(service, claim, payer, code) -> None:
    assert failure_code(lambda: accept(service, claim, payer=payer)) == code


def test_missing_channel_is_rejected() -> None:
    service = PaychanRuntime(
        replace(runtime().dependencies, channel_reader=Reader(None))
    )
    assert failure_code(lambda: accept(service)) == "PAYCHAN_CHANNEL_NOT_FOUND"


def test_local_verifier_unavailable_uses_only_injected_rippled_fallback() -> None:
    fallback = RippledVerifier()

    def unavailable(_proof: ClaimProof) -> bool:
        raise LocalVerifierUnavailable("unsupported local runtime")

    accepted = accept(runtime(local_verifier=unavailable, rippled_verifier=fallback))
    assert accepted.status == "claim_accepted"
    assert fallback.calls == [(CHANNEL, PRICE_DROPS, SIGNATURE, PUBLIC_KEY)]


@pytest.mark.parametrize("cumulative", ["1", "49999", "50001", "99999", "100001"])
def test_claim_increment_must_equal_trusted_price(cumulative: str) -> None:
    assert failure_code(lambda: accept(runtime(), proof(cumulative))) == "PAYCHAN_AMOUNT_MISMATCH"


def test_exact_increment_and_replay_are_atomic_and_idempotent() -> None:
    service = runtime()
    first = accept(service)
    replay = accept(service)
    second = accept(service, proof("100000", signature="31"))
    assert (first.status, replay.status, second.status) == (
        "claim_accepted",
        "claim_replay",
        "claim_accepted",
    )
    assert (first.accepted_count, replay.accepted_count, second.accepted_count) == (1, 1, 2)


def test_same_claim_cannot_be_replayed_for_a_different_challenge() -> None:
    service = runtime()
    assert accept(service).status == "claim_accepted"
    assert failure_code(
        lambda: asyncio.run(
            service.accept_claim(
                "merchant",
                DESTINATION,
                proof(),
                credentialed_payer=SOURCE,
                expected_increment_drops=PRICE_DROPS,
                acceptance_key="state-2",
            )
        )
    ) == "PAYCHAN_CLAIM_CONFLICT"


def test_concurrent_same_claim_has_one_acceptance_and_one_replay() -> None:
    service = runtime()

    async def race():
        return await asyncio.gather(
            service.accept_claim(
                "merchant",
                DESTINATION,
                proof(),
                credentialed_payer=SOURCE,
                expected_increment_drops=PRICE_DROPS,
                acceptance_key="state-1",
            ),
            service.accept_claim(
                "merchant",
                DESTINATION,
                proof(),
                credentialed_payer=SOURCE,
                expected_increment_drops=PRICE_DROPS,
                acceptance_key="state-1",
            ),
        )

    results = asyncio.run(race())
    assert sorted(item.status for item in results) == ["claim_accepted", "claim_replay"]


def test_validator_adapter_uses_exact_five_field_proof_and_trusted_increment() -> None:
    service = runtime()
    raw = {
        "type": "xrpl_paychan_claim",
        "channel_id": CHANNEL,
        "cumulative_drops": PRICE_DROPS,
        "signature": SIGNATURE,
        "public_key": PUBLIC_KEY,
    }
    request = SimpleNamespace(
        payment_proof=raw,
        challenge=SimpleNamespace(
            state_id="state-1",
            merchant_id="merchant",
            merchant_address=DESTINATION,
            paychan_claim_drops=PRICE_DROPS,
        ),
    )
    result = asyncio.run(service.validate_claim(request, credentialed_payer=SOURCE))
    assert result.tx_hash == service.retry_key(raw)
    assert result.validated is True
    assert result.engine_result == "claim_accepted"
    assert (result.delivered_currency, result.delivered_issuer, result.delivered_value) == (
        "XRP",
        None,
        PRICE_DROPS,
    )


def test_sqlite_store_preserves_highest_claim_across_instances(tmp_path) -> None:
    path = tmp_path / "claims.sqlite3"
    first = runtime(store=SQLiteClaimStore(path))
    second = runtime(store=SQLiteClaimStore(path))
    assert accept(first).status == "claim_accepted"
    assert accept(second).status == "claim_replay"
    assert accept(second, proof("100000", signature="31")).accepted_count == 2
    reopened = SQLiteClaimStore(path)
    latest = asyncio.run(reopened.latest("merchant", CHANNEL))
    assert len(latest) == 1
    assert latest[0].cumulative_drops == "100000"


def test_cross_runtime_sqlite_settlement_has_one_submit_and_first_event(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "claims.sqlite3"
        store_a = SQLiteClaimStore(path)
        store_b = SQLiteClaimStore(path)
        submitter = Submitter()
        submitter.entered = asyncio.Event()
        submitter.release = asyncio.Event()
        events: list[tuple[str, dict[str, str]]] = []

        async def sink(kind: str, detail: dict[str, str]) -> None:
            events.append((kind, dict(detail)))

        first = runtime(store=store_a, submitter=submitter, event_sink=sink)
        second = runtime(store=store_b, submitter=submitter, event_sink=sink)
        await first.accept_claim(
            "merchant",
            DESTINATION,
            proof(),
            credentialed_payer=SOURCE,
            expected_increment_drops=PRICE_DROPS,
            acceptance_key="state-1",
        )
        settling = asyncio.create_task(first.settle("merchant", CHANNEL))
        await submitter.entered.wait()
        with pytest.raises(PaychanFailure) as caught:
            await second.settle("merchant", CHANNEL)
        assert caught.value.code == "PAYCHAN_SETTLEMENT_UNCERTAIN"
        submitter.release.set()
        settled = await settling
        replay = await second.settle("merchant", CHANNEL)
        assert settled.replayed is False and replay.replayed is True
        assert len(submitter.calls) == 1
        assert submitter.calls[0][1] == {
            "TransactionType": "PaymentChannelClaim",
            "Channel": CHANNEL,
            "Balance": PRICE_DROPS,
            "Amount": PRICE_DROPS,
            "Signature": SIGNATURE,
            "PublicKey": PUBLIC_KEY,
        }
        assert events == [
            (
                "claim_redeemed",
                {
                    "merchant_id": "merchant",
                    "channel_id": CHANNEL,
                    "cumulative_drops": PRICE_DROPS,
                    "tx_hash": TX_HASH,
                },
            )
        ]

    asyncio.run(scenario())


def test_ambiguous_submit_failure_remains_durably_fenced(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "claims.sqlite3"
        failing = Submitter(RuntimeError("transport lost after possible submit"))
        first = runtime(store=SQLiteClaimStore(path), submitter=failing)
        await first.accept_claim(
            "merchant",
            DESTINATION,
            proof(),
            credentialed_payer=SOURCE,
            expected_increment_drops=PRICE_DROPS,
            acceptance_key="state-1",
        )
        with pytest.raises(PaychanFailure) as initial:
            await first.settle("merchant", CHANNEL)
        assert initial.value.code == "PAYCHAN_SUBMIT_FAILED"

        replacement = Submitter()
        recovered = runtime(store=SQLiteClaimStore(path), submitter=replacement)
        with pytest.raises(PaychanFailure) as replay:
            await recovered.settle("merchant", CHANNEL)
        assert replay.value.code == "PAYCHAN_SETTLEMENT_UNCERTAIN"
        assert replacement.calls == []

    asyncio.run(scenario())


def test_failed_event_delivery_retries_without_resubmitting(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "claims.sqlite3"
        submitter = Submitter()
        delivered: list[str] = []
        attempts = 0

        async def flaky_sink(kind: str, _detail: dict[str, str]) -> None:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("telemetry unavailable")
            delivered.append(kind)

        service = runtime(
            store=SQLiteClaimStore(path),
            submitter=submitter,
            event_sink=flaky_sink,
        )
        await service.accept_claim(
            "merchant",
            DESTINATION,
            proof(),
            credentialed_payer=SOURCE,
            expected_increment_drops=PRICE_DROPS,
            acceptance_key="state-1",
        )
        first = await service.settle("merchant", CHANNEL)
        replay = await service.settle("merchant")
        second_replay = await service.settle("merchant", CHANNEL)
        assert first.replayed is False
        assert replay.replayed is second_replay.replayed is True
        assert len(submitter.calls) == 1
        assert attempts == 2
        assert delivered == ["claim_redeemed"]

    asyncio.run(scenario())


def test_newer_redemption_waits_for_prior_event_delivery(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "claims.sqlite3"
        submitter = Submitter()
        delivered: list[tuple[str, str]] = []
        allow_delivery = False

        async def controlled_sink(kind: str, detail: dict[str, str]) -> None:
            if not allow_delivery:
                raise RuntimeError("event sink unavailable")
            delivered.append((kind, detail["cumulative_drops"]))

        service = runtime(
            store=SQLiteClaimStore(path),
            submitter=submitter,
            event_sink=controlled_sink,
        )
        await service.accept_claim(
            "merchant",
            DESTINATION,
            proof(),
            credentialed_payer=SOURCE,
            expected_increment_drops=PRICE_DROPS,
            acceptance_key="state-1",
        )
        first = await service.settle("merchant", CHANNEL)
        assert first.replayed is False
        assert len(submitter.calls) == 1

        await service.accept_claim(
            "merchant",
            DESTINATION,
            proof("100000", signature="31"),
            credentialed_payer=SOURCE,
            expected_increment_drops=PRICE_DROPS,
            acceptance_key="state-2",
        )
        with pytest.raises(PaychanFailure) as pending:
            await service.settle("merchant")
        assert pending.value.code == "PAYCHAN_EVENT_PENDING"
        assert len(submitter.calls) == 1

        allow_delivery = True
        event_replay = await service.settle("merchant")
        assert event_replay.replayed is True
        assert event_replay.cumulative_drops == PRICE_DROPS
        assert len(submitter.calls) == 1

        newer = await service.settle("merchant")
        assert newer.replayed is False
        assert newer.cumulative_drops == "100000"
        assert len(submitter.calls) == 2
        assert delivered == [
            ("claim_redeemed", PRICE_DROPS),
            ("claim_redeemed", "100000"),
        ]

    asyncio.run(scenario())


def test_validated_older_redemption_preserves_newer_claim_pending(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "claims.sqlite3"
        store = SQLiteClaimStore(path)
        submitter = Submitter()
        submitter.entered = asyncio.Event()
        submitter.release = asyncio.Event()
        service = runtime(store=store, submitter=submitter)
        await service.accept_claim(
            "merchant",
            DESTINATION,
            proof(),
            credentialed_payer=SOURCE,
            expected_increment_drops=PRICE_DROPS,
            acceptance_key="state-2",
        )
        settling = asyncio.create_task(service.settle("merchant", CHANNEL))
        await submitter.entered.wait()
        newer = await service.accept_claim(
            "merchant",
            DESTINATION,
            proof("100000", signature="31"),
            credentialed_payer=SOURCE,
            expected_increment_drops=PRICE_DROPS,
            acceptance_key="state-1",
        )
        submitter.release.set()
        await settling
        pending = await store.pending("merchant", CHANNEL)
        assert newer.status == "claim_accepted"
        assert len(pending) == 1
        assert pending[0].cumulative_drops == "100000"
        assert pending[0].redeemed_drops == PRICE_DROPS
        assert pending[0].redeeming_drops is None

    asyncio.run(scenario())


def test_auto_settle_requires_submitter_and_redeems_exact_every_n() -> None:
    with pytest.raises(ValueError, match="requires a submitter"):
        runtime(auto_settle_every=2)

    submitter = Submitter()
    events: list[str] = []

    async def sink(kind: str, _detail: dict[str, str]) -> None:
        events.append(kind)

    service = runtime(submitter=submitter, event_sink=sink, auto_settle_every=2)
    assert accept(service).settlement_due is False
    second = accept(service, proof("100000", signature="31"))
    assert second.settlement_due is True
    assert len(submitter.calls) == 1
    assert events == ["claim_redeemed"]
