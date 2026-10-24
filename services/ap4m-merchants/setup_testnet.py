#!/usr/bin/env python3
"""Print the idempotent XRPL Testnet merchant setup plan without executing it.

MM1 is deliberately dry-run only.  This module never reads environment files,
loads keys, connects to XRPL, signs, funds, or submits a transaction.  Event-day
live execution belongs to the later reset/rehearsal package.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Sequence


TESTNET_FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts"
TESTNET_JSON_RPC_URL = "https://s.altnet.rippletest.net:51234/"
DEFAULT_MERCHANTS = (
    "rVenueYieldDeskDemo11111111111111111",
    "rRiskOracleDemo111111111111111111111",
)
DEFAULT_STABLE_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"
DEFAULT_DEMO_NETWORK_ISSUER = "rDemoNetworkIssuer111111111111111111"
DEFAULT_CREDENTIAL_TYPE_HEX = "4150344D2D4167656E74"


@dataclass(frozen=True)
class PlanStep:
    id: str
    phase: str
    account: str
    kind: str
    request: dict[str, Any]
    idempotency_check: str


def _faucet_step(account: str) -> PlanStep:
    return PlanStep(
        id=f"{account}:fund-before-deposit-auth",
        phase="fund",
        account=account,
        kind="faucet_request",
        request={
            "method": "POST",
            "url": TESTNET_FAUCET_URL,
            "body": {"destination": account},
        },
        idempotency_check=(
            "Skip when account_info reports a funded account; this must run before "
            "asfDepositAuth because later faucet top-ups are expected to be rejected."
        ),
    )


def normalize_currency(code: str) -> str:
    """Return an XRPL currency code, hex-encoding codes longer than 3 bytes."""

    candidate = code.strip()
    if len(candidate) == 3:
        return candidate.upper()
    if len(candidate) == 40:
        try:
            bytes.fromhex(candidate)
        except ValueError as error:
            raise ValueError("40-character currency codes must be hexadecimal") from error
        return candidate.upper()
    raw = candidate.encode("utf-8")
    if not raw or len(raw) > 20:
        raise ValueError("currency code must contain 1 to 20 UTF-8 bytes")
    return raw.hex().upper().ljust(40, "0")


def _trust_set_step(account: str, stable_code: str, stable_issuer: str) -> PlanStep:
    # TrustSet fields: https://xrpl.org/docs/references/protocol/transactions/types/trustset
    tx = {
        "TransactionType": "TrustSet",
        "Account": account,
        "LimitAmount": {
            "currency": stable_code,
            "issuer": stable_issuer,
            "value": "1000000000",
        },
    }
    return PlanStep(
        id=f"{account}:trust:{stable_code}:{stable_issuer}",
        phase="trust-line",
        account=account,
        kind="transaction",
        request=tx,
        idempotency_check=(
            "Skip when account_lines already contains this currency and issuer with a "
            "limit of at least 1000000000."
        ),
    )


def _deposit_auth_step(account: str) -> PlanStep:
    # AccountSet/asfDepositAuth: https://xrpl.org/docs/references/protocol/transactions/types/accountset
    tx = {
        "TransactionType": "AccountSet",
        "Account": account,
        "SetFlag": 9,
    }
    return PlanStep(
        id=f"{account}:deposit-auth",
        phase="deposit-auth",
        account=account,
        kind="transaction",
        request=tx,
        idempotency_check=(
            "Skip when account_info AccountRoot Flags already includes asfDepositAuth."
        ),
    )


def _credential_preauth_step(
    account: str,
    demo_network_issuer: str,
    credential_type_hex: str,
) -> PlanStep:
    # Credential-based DepositPreauth fields:
    # https://xrpl.org/docs/references/protocol/transactions/types/depositpreauth
    tx = {
        "TransactionType": "DepositPreauth",
        "Account": account,
        "AuthorizeCredentials": [
            {
                "Credential": {
                    "Issuer": demo_network_issuer,
                    "CredentialType": credential_type_hex,
                }
            }
        ],
    }
    return PlanStep(
        id=(
            f"{account}:credential-preauth:{demo_network_issuer}:"
            f"{credential_type_hex}"
        ),
        phase="credential-preauth",
        account=account,
        kind="transaction",
        request=tx,
        idempotency_check=(
            "Skip when account_objects already contains a DepositPreauth ledger object "
            "with this single credential issuer and type."
        ),
    )


def build_setup_plan(
    merchants: Iterable[str],
    *,
    stable_code: str,
    stable_issuer: str,
    demo_network_issuer: str,
    credential_type_hex: str,
) -> dict[str, Any]:
    """Return a deterministic plan with safety-critical ordering."""

    accounts = tuple(dict.fromkeys(merchant.strip() for merchant in merchants if merchant.strip()))
    if len(accounts) != 2:
        raise ValueError("exactly two distinct merchant accounts are required")
    if not stable_code or not stable_issuer or not demo_network_issuer:
        raise ValueError("stable asset and demo-network issuer values are required")
    if (
        not credential_type_hex
        or len(credential_type_hex) % 2
        or len(credential_type_hex) > 128
    ):
        raise ValueError("credential type must be a non-empty even-length hex string")
    try:
        bytes.fromhex(credential_type_hex)
    except ValueError as error:
        raise ValueError("credential type must be hexadecimal") from error

    ledger_stable_code = normalize_currency(stable_code)
    steps: list[PlanStep] = []
    for account in accounts:
        steps.append(_faucet_step(account))
    for account in accounts:
        steps.append(_trust_set_step(account, ledger_stable_code, stable_issuer))
    for account in accounts:
        steps.append(_deposit_auth_step(account))
    for account in accounts:
        steps.append(
            _credential_preauth_step(
                account,
                demo_network_issuer,
                credential_type_hex.upper(),
            )
        )

    return {
        "mode": "dry-run",
        "network": "testnet",
        "rpc_url": TESTNET_JSON_RPC_URL,
        "executes": False,
        "signs": False,
        "reads_credentials": False,
        "stable_asset": {
            "display_currency": stable_code,
            "currency": ledger_stable_code,
            "issuer": stable_issuer,
        },
        "required_credential": {
            "issuer": demo_network_issuer,
            "credential_type_hex": credential_type_hex.upper(),
        },
        "ordering": ["fund", "trust-line", "deposit-auth", "credential-preauth"],
        "notes": [
            "Fund and establish trust lines before enabling DepositAuth.",
            "PaymentChannelCreate to a DepositAuth destination remains a LIVE=1 verification.",
            "If that verification fails, reset may explicitly preauthorize the owner account.",
        ],
        "steps": [asdict(step) for step in steps],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Required safety switch; print JSON and perform no external action.",
    )
    parser.add_argument(
        "--merchant",
        action="append",
        dest="merchants",
        help="Public merchant address; pass exactly twice (defaults are mock placeholders).",
    )
    parser.add_argument("--stable-code", default="RLUSD")
    parser.add_argument("--stable-issuer", default=DEFAULT_STABLE_ISSUER)
    parser.add_argument("--demo-network-issuer", default=DEFAULT_DEMO_NETWORK_ISSUER)
    parser.add_argument("--credential-type-hex", default=DEFAULT_CREDENTIAL_TYPE_HEX)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not args.dry_run:
        raise SystemExit("refusing execution: MM1 supports --dry-run only")
    plan = build_setup_plan(
        args.merchants or DEFAULT_MERCHANTS,
        stable_code=args.stable_code,
        stable_issuer=args.stable_issuer,
        demo_network_issuer=args.demo_network_issuer,
        credential_type_hex=args.credential_type_hex,
    )
    print(json.dumps(plan, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
