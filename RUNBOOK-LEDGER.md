# Ledger event-day runbook

This runbook is for Pilot's **local Testnet profile only**. It does not authorize mainnet, a hosted Ledger,
private seeds, faucet use, signing, submission, or changes to the protected demo runtime. Austin performs or
explicitly approves the event-day actions; Codex validates the resulting public, read-only evidence.

`scripts/ledger/preflight.mjs` is deliberately passive. It does not discover devices, launch a browser, call a
faucet, contact XRPL or Harbor, sign, submit, or read environment files. It validates a strict report created by
the explicit probes below and binds every result to one selected account index, public owner address and the exact
public Harbor delegate selected by the event build.

## Pitch lane: generated simulation, no device authority

Physical Ledger/WebHID validation is not required for the team pitch. Generate
the deterministic simulated-device visuals locally from the checked-in fixtures.
They demonstrate the review experience and do not sign, submit, validate a
Testnet transaction, or satisfy the event-day preflight below.
in-memory component capture. It launches headless Chromium, renders the checked-in components and fixtures with
`page.setContent`, and fails if a HTTP(S) request occurs:

```sh
pnpm exec tsx scripts/capture-ledger-pitch.ts
```

The route-level fixture regression remains:

```sh
PILOT_E2E_LANE=fixture \
PILOT_E2E_FIXTURE_BASE_URL=http://127.0.0.1:3024 \
  pnpm exec playwright test e2e/ledger-simulated-demo.fixture.spec.ts \
  --project=fixture --workers=1 --retries=0
```

Pitch presentation state:

1. `/demo/ledger` and the logged-out chat fixture are presentation-ready recorded
   address/permission/owner-approval screens. The UI says
   **Recorded demo · no signing** and never offers a real sign or submit action.
2. `/` → **Approve on Ledger** is a presentation-ready view of the three-step boundary, recorded clear-signed
   `TrustSet` screen and honest blind-signed `DelegateSet` legend.

The authoritative pitch captures and their checksums are indexed in `test-results/playwright/ledger-pitch/README.md`. Say
"recorded from Speculos" or "simulated Ledger replay"—never "signed on hardware", "validated on Testnet" or
"production accepted". The optional local Speculos emulator may be shown only as a separate virtual-device
demonstration using its public default seed. Its 10/10 conformance result remains emulator evidence, not physical
hardware or Testnet evidence.

The rest of this runbook is the future live/Testnet lane. It remains red until its literal checks pass.

## Hard boundaries

- Testnet only. Stop immediately if any UI, report or transaction says mainnet.
- Never paste or record a mnemonic, seed, private key, APDU, unsigned/signed transaction blob, authorization
  header, cookie, or Harbor credential. The report contains public status only.
- Use the Speculos **public default test seed** only. Do not create or load another seed.
- Real Ledger and WebHID checks require a person at the device. Never approve a device prompt unattended.
- Keep blind signing off except while reviewing the exact seven-permission `DelegateSet` or its empty-permission
  revocation. Turn it off immediately afterward.
- The simulated device signs nothing. It can preserve the visual demo but cannot satisfy a signing, Testnet or
  preflight claim.

## Night before

1. On the Mac mini, fetch the exact event build and confirm the destination integrity check passes.
2. With the physical Ledger in hand, update its firmware through Ledger Wallet. Reconnect it and verify the
   update completed; do not record device identifiers.
3. Install or update the XRP app through Ledger Wallet and confirm version **2.8.2 or newer**.
4. Open the XRP app settings and make sure blind signing is **off**.
5. Use current desktop Chrome. Record its four-part version from `chrome://version`. In the Pilot tab's developer
   console, evaluate `'hid' in navigator`; the result must be `true`.
6. Pick one XRP account index from 0 through 9. In Pilot, connect from a user click, select that index, and run
   **Verify address on device**. Copy only the resulting public classic address.
7. Prepare the local Virtual Ledger fallback on the Mac mini. Its only allowed endpoints are
   `http://127.0.0.1:5000` (API) and `http://127.0.0.1:9999` (APDU).

The real-device connection, firmware/app update and WebHID verification are **pending event-day checks** until a
physical device and its owner are present. They are not passed by this document or by offline tests.

## Explicit preflight probes

Run these in order. Each step is an explicit operator action; nothing runs merely because the validator starts.

### 1. Browser and device

1. Record Chrome's four-part version and the boolean `navigator.hid` result.
2. Connect the chosen mode from a click in Pilot:
   - `real`: Chrome WebHID and the physical Ledger;
   - `virtual`: Pilot's local proxy to Speculos on the Mac mini.
3. Confirm Pilot reports the XRP app version, chosen index and public address.
4. Run the on-device address check. For the virtual mode, approve the Speculos address screen; for the real mode,
   compare and approve the address on the physical display.

Do not continue if the app is not XRP, its version is below 2.8.2, the address differs, or the address has not been
verified on the device.

### 2. Testnet account and official RLUSD line

Using Pilot's existing read-only Testnet account status path, record:

- network exactly `testnet`;
- the same public address;
- AccountRoot exists and XRP balance in drops is greater than zero;
- the official RLUSD Testnet line exists for issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` and currency
  `524C555344000000000000000000000000000000`;
- the status and trust line come from the same validated ledger index/hash;
- its limit is exactly `10000`, it is authorized, and it is not frozen.

If the account is unfunded or the line is absent, stop. Funding from the faucet and signing a `TrustSet` are
separate event-day actions requiring Austin and the device owner. After those actions validate on Testnet, rerun
this read-only probe. Offline or mocked results never replace it.

### 3. Harbor link

Use the existing authenticated Pilot account-status flow to read `account.status` for the same Testnet owner.
Record only the public result: `active`, the public delegate address and the exact ordered permissions:

`OfferCreate`, `OfferCancel`, `TrustSet`, `AMMDeposit`, `AMMWithdraw`, `EscrowFinish`, `CheckCash`.

Before validating, copy the public delegate shown by the exact event build. The validator's `--delegate` argument is
that expected value; `account.status.delegate` must match it exactly. A different active delegate is a stop even when
its permissions happen to match.

If a link must be created, leave blind signing off until Pilot reaches the delegate explanation. Then turn blind
signing on, compare that exact event-build Harbor delegate and values `8, 9, 21, 37, 38, 3, 18` on the device,
approve once, wait for validated Testnet status, reread `account.status`, and require the same delegate before turning
blind signing off. This mutating action is event-day only.

### 4. Virtual Ledger fallback

Start the already authorized local emulator on the Mac mini in a separate terminal:

```sh
pnpm ledger:sim
```

It must use the public default seed and remain bound to `127.0.0.1:5000` and `127.0.0.1:9999`. Then, from the Pilot
checkout, run the conformance suite while a person drives the displayed prompts:

```sh
LEDGER_SPECULOS_URL=http://127.0.0.1:5000 pnpm ledger:conformance
```

Record `reachable: true`, `public_default_seed: true` and conformance exactly `10/10` only after that literal run
passes. Do not store its transaction bytes or signatures.

### 5. Validate the report

Create a temporary JSON report outside git using this exact shape. Replace the placeholders with public event-day
observations; do not add fields.

```json
{
  "version": 2,
  "mode": "virtual",
  "browser": {
    "source": "browser-capability-probe",
    "product": "Chrome",
    "version": "000.0.0.0",
    "navigator_hid": true
  },
  "device": {
    "source": "ledger-device-probe",
    "transport": "speculos",
    "connected": true,
    "app_name": "XRP",
    "app_version": "2.8.2",
    "account_index": 0,
    "address": "REPLACE_WITH_PUBLIC_ADDRESS",
    "verified_on_device": true
  },
  "testnet": {
    "source": "xrpl-testnet-read",
    "network": "testnet",
    "address": "REPLACE_WITH_PUBLIC_ADDRESS",
    "account_exists": true,
    "xrp_balance_drops": "REPLACE_WITH_CANONICAL_DROPS",
    "validated": true,
    "ledger_index": 99999999,
    "ledger_hash": "REPLACE_WITH_UPPERCASE_64_HEX_VALIDATED_LEDGER_HASH",
    "rlusd_trust_line": {
      "currency": "524C555344000000000000000000000000000000",
      "issuer": "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      "limit": "10000",
      "balance": "REPLACE_WITH_NON_NEGATIVE_BALANCE",
      "authorized": true,
      "frozen": false
    }
  },
  "harbor": {
    "source": "harbor-account-status",
    "network": "testnet",
    "owner": "REPLACE_WITH_PUBLIC_ADDRESS",
    "delegate": "REPLACE_WITH_EXACT_EVENT_BUILD_PUBLIC_DELEGATE",
    "status": "active",
    "permissions": [
      "OfferCreate",
      "OfferCancel",
      "TrustSet",
      "AMMDeposit",
      "AMMWithdraw",
      "EscrowFinish",
      "CheckCash"
    ]
  },
  "speculos": {
    "source": "ledger-conformance",
    "api_url": "http://127.0.0.1:5000",
    "apdu_url": "http://127.0.0.1:9999",
    "reachable": true,
    "public_default_seed": true,
    "conformance": { "passed": 10, "total": 10 }
  }
}
```

For a real Ledger report, use mode `real` and transport `webhid`. The Speculos fallback must still be up and pass
10/10. Validate without printing raw provider responses:

```sh
node scripts/ledger/preflight.mjs \
  --mode virtual \
  --account-index 0 \
  --address REPLACE_WITH_PUBLIC_ADDRESS \
  --delegate REPLACE_WITH_EXACT_EVENT_BUILD_PUBLIC_DELEGATE \
  --evidence ${LEDGER_PUBLIC_EVIDENCE_PATH:?set LEDGER_PUBLIC_EVIDENCE_PATH}
```

Green is exactly five `PASS` lines and `5/5 preflight checks passed`. A failure is a stop: correct the named
probe, collect a fresh public result and rerun. Never edit a failed observation into a passing claim.

## Demo fallback order

1. **Real Ledger** in Chrome/WebHID. Use only after the real-device preflight passes.
2. **Virtual Ledger on the Mac mini.** Use only after the virtual report and conformance 10/10 pass.
3. **Simulated device.** Visual replay only. Say plainly that it is recorded and does not sign. Do not claim a
   Testnet transaction, hardware approval, or passing Ledger preflight from this fallback.

Do not change the running Pilot, Harbor, merchant or wallet services while switching fallbacks. Use only the
designated local profile and ports.

## After judging: revoke and leave the device safe

This sequence requires the device owner and Testnet authority; it is pending until performed.

1. In Pilot, request `account.revoke` for the exact active owner/link. Require its public delegate to equal the
   preflight's exact event-build delegate and inspect the returned blind-signing legend.
2. Turn blind signing on only for the empty-permission `DelegateSet` revocation.
3. On the Ledger, compare the owner, delegate, fee and empty permissions, then approve. The Ledger remains sign-only;
   Pilot relays through the existing account-revoke path.
4. Wait for a validated Testnet result. Reread `account.status` and require the same delegate, `revoked`, and zero
   permissions.
5. Turn blind signing off on the device and verify it is off before disconnecting.
6. Disconnect/forget the Pilot Ledger session and stop the local Speculos fallback. Do not delete shared state,
   secrets, wallets or evidence.

Record only public hashes, ledger indices, public addresses and the final revoked status in the event evidence.

## Current completion state

Generate all simulation captures and verification results from the current
destination before use. No historical capture, hardware result, signature,
transaction, Testnet result, or acceptance record is bundled as destination
evidence. Physical-device and live-network checks remain future manual lanes.
