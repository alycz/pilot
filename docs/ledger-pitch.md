# Approve on Ledger

## Deck slide

**Bounded automation. Owner control beyond the boundary.**

1. **The agent proposes.** Pilot turns the request into a typed intent and an exact XRPL transaction. The agent never holds the owner key.
2. **Harbor's bounded delegate executes.** Within the permissions granted on-ledger and the limits checked by Harbor, the delegate can execute without another owner signature.
3. **The Ledger approves anything beyond it.** When an action exceeds that bounded authority, the owner reviews and signs the exact transaction on the Ledger.

**Device visual:** the clear-signed `TrustSet` screen from LG-5's deterministic local simulated-device transcript.
The newly generated landing capture is `test-results/playwright/ledger-pitch/lg7-landing-trustset.png`; the logged-out approval-dialog
capture is `test-results/playwright/ledger-pitch/lg4-logged-out-approval-dialog.png`. Both are deterministic static component
renders made from checked-in fixtures with HTTP(S) requests forbidden; they are not app-runtime acceptance evidence.
Both captures are presentation-ready; the landing image includes the reviewed source-level paper-surface contrast
repair and does not use a capture-only styling override.

This mirrors **Ledger Agent Intent's** human-in-the-loop model for XRPL. **Ledger Agent Intent does not support XRPL yet.** Pilot uses Ledger's **Device Management Kit (DMK), not legacy LedgerJS**.

`DelegateSet` is **blind-signed** in Ledger's XRP app 2.8.2. In the onboarding approval, Pilot says so plainly and shows the full Harbor delegate address beside this seven-entry legend:

- `Unknown [1] | 8` — `OfferCreate`: place DEX offers (swaps) within policy.
- `Unknown [2] | 9` — `OfferCancel`: cancel its own offers.
- `Unknown [3] | 21` — `TrustSet`: add or adjust trust lines.
- `Unknown [4] | 37` — `AMMDeposit`: add liquidity to AMM pools.
- `Unknown [5] | 38` — `AMMWithdraw`: remove liquidity.
- `Unknown [6] | 3` — `EscrowFinish`: finish escrows.
- `Unknown [7] | 18` — `CheckCash`: cash checks.

## Speaker note

The device visual and approval states are deterministic local simulated-device evidence. They are not physical-Ledger, live-Testnet, hosted, or production acceptance evidence. Do not describe a Ledger signature or XRPL transaction as validated unless the corresponding LG-3 or LG-4 status evidence records it.

Physical Ledger/WebHID validation is a future product-validation lane, not a prerequisite for this pitch. Use the
simulation-only steps in `RUNBOOK-LEDGER.md`; keep Virtual Ledger Testnet hashes and the literal LG-8 preflight
separate and pending until they are actually run.
