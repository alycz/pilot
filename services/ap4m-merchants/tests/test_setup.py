from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from setup_testnet import build_setup_plan  # noqa: E402


MERCHANTS = ("rMerchantA", "rMerchantB")


def plan():
    return build_setup_plan(
        MERCHANTS,
        stable_code="tUSD",
        stable_issuer="rStableIssuer",
        demo_network_issuer="rDemoIssuer",
        credential_type_hex="4150344D2D4167656E74",
    )


class SetupPlanTests(unittest.TestCase):
    def test_plan_is_testnet_dry_run_without_credential_access(self):
        result = plan()

        self.assertEqual(result["network"], "testnet")
        self.assertFalse(result["executes"])
        self.assertFalse(result["signs"])
        self.assertFalse(result["reads_credentials"])
        self.assertEqual(result["stable_asset"]["display_currency"], "tUSD")
        self.assertEqual(
            result["stable_asset"]["currency"],
            "7455534400000000000000000000000000000000",
        )
        self.assertEqual(result["stable_asset"]["issuer"], "rStableIssuer")

    def test_plan_orders_both_merchants_before_deposit_auth(self):
        steps = plan()["steps"]

        self.assertEqual(
            [step["phase"] for step in steps],
            [
                "fund",
                "fund",
                "trust-line",
                "trust-line",
                "deposit-auth",
                "deposit-auth",
                "credential-preauth",
                "credential-preauth",
            ],
        )
        first_deposit_auth = next(
            index for index, step in enumerate(steps) if step["phase"] == "deposit-auth"
        )
        self.assertTrue(
            all(
                step["phase"] in {"fund", "trust-line"}
                for step in steps[:first_deposit_auth]
            )
        )

    def test_transaction_shapes_are_exact_and_idempotent(self):
        steps = plan()["steps"]
        trust = next(step for step in steps if step["phase"] == "trust-line")
        account_set = next(step for step in steps if step["phase"] == "deposit-auth")
        preauth = next(step for step in steps if step["phase"] == "credential-preauth")

        self.assertEqual(
            trust["request"],
            {
                "TransactionType": "TrustSet",
                "Account": "rMerchantA",
                "LimitAmount": {
                    "currency": "7455534400000000000000000000000000000000",
                    "issuer": "rStableIssuer",
                    "value": "1000000000",
                },
            },
        )
        self.assertEqual(
            account_set["request"],
            {
                "TransactionType": "AccountSet",
                "Account": "rMerchantA",
                "SetFlag": 9,
            },
        )
        self.assertEqual(
            preauth["request"],
            {
                "TransactionType": "DepositPreauth",
                "Account": "rMerchantA",
                "AuthorizeCredentials": [
                    {
                        "Credential": {
                            "Issuer": "rDemoIssuer",
                            "CredentialType": "4150344D2D4167656E74",
                        }
                    }
                ],
            },
        )
        self.assertTrue(all(step["id"] and step["idempotency_check"] for step in steps))

    def test_plan_requires_two_distinct_merchants_and_hex_credential_type(self):
        kwargs = {
            "stable_code": "RLUSD",
            "stable_issuer": "rStableIssuer",
            "demo_network_issuer": "rDemoIssuer",
            "credential_type_hex": "4150",
        }

        with self.assertRaisesRegex(ValueError, "exactly two"):
            build_setup_plan(["rOnlyOne"], **kwargs)
        with self.assertRaisesRegex(ValueError, "exactly two"):
            build_setup_plan(["rSame", "rSame"], **kwargs)
        with self.assertRaisesRegex(ValueError, "hexadecimal"):
            build_setup_plan(
                MERCHANTS,
                **{**kwargs, "credential_type_hex": "zz"},
            )

    def test_cli_requires_dry_run_and_prints_json(self):
        script = SERVICE_ROOT / "setup_testnet.py"
        refused = subprocess.run(
            [sys.executable, str(script)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("dry-run only", refused.stderr)

        accepted = subprocess.run(
            [sys.executable, str(script), "--dry-run"],
            check=True,
            capture_output=True,
            text=True,
        )
        output = json.loads(accepted.stdout)
        self.assertEqual(output["mode"], "dry-run")
        self.assertEqual(len(output["steps"]), 8)


if __name__ == "__main__":
    unittest.main()
