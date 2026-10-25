# Hosted Ledger companion

This is a default-off, loopback-only bridge from one exact hosted Pilot origin
to the repository's local Speculos XRP emulator. It is for the public default
emulator test seed and XRPL Testnet only. It signs one exact, locally reviewed
action and never submits it.

The companion is deliberately semantic. The hosted page cannot access raw
APDUs, arbitrary Speculos paths, URLs, RPC methods, screenshots, or emulator
buttons. Screen and button controls exist only inside the separately opened,
same-origin local review page.

## Required local software

- Node.js and pnpm versions pinned by the repository.
- The checked-in XRP app fixture and either the already-supported local
  Speculos installation or Docker runtime.
- A Chromium browser that implements Local Network Access for HTTPS-to-loopback
  requests. The user must grant the browser's loopback-network prompt.

No account, API key, cloud resource, funded wallet, or private seed is needed.
Do not set `SEED_FILE`; the hosted demo is restricted to Speculos's public
default test seed.

## Configuration placeholders

The hosted web build is disabled unless:

```text
NEXT_PUBLIC_LEDGER_COMPANION_ENABLED=1
```

The local companion refuses to start unless all four values are present and
exact:

```text
PILOT_LEDGER_COMPANION_ENABLED=1
TEST_LEDGER_SPECULOS=1
LEDGER_SPECULOS_URL=http://127.0.0.1:5000
PILOT_LEDGER_COMPANION_APPROVED_ORIGIN=https://<exact-hosted-pilot-origin>
```

Enter those values in the operator's local shell or approved local secret/env
manager. They contain no credentials. Never put tokens, seed material, signed
transactions, or pairing capabilities into env files, source control, URLs,
logs, clipboard handoffs, or browser storage.

The hosted response policy must allow only
`connect-src http://127.0.0.1:43659` in addition to its normal destinations and
must not disable the browser's loopback-network permission. Do not loosen that
to `localhost`, `127.0.0.0/8`, a wildcard, a LAN address, or an operator-supplied
URL.

## Local verification

1. Verify the repository integrity manifest with `pnpm repro:verify`.
2. Start a fresh emulator with `pnpm ledger:sim`. The existing launcher binds
   its API and APDU ports to `127.0.0.1`; do not change those bindings.
3. In another shell, set the four local companion values above and run
   `pnpm ledger:companion`. The fixed port is `127.0.0.1:43659`; an occupied
   port is a hard failure and is never replaced or bypassed.
4. Open `http://127.0.0.1:43659/ui` yourself. Keep this local review page open.
5. From an HTTPS build with the public flag enabled, open
   `/demo/ledger-companion`, click **Pair exact fixture**, grant the browser's
   loopback-network permission, and compare the origin, account, amount,
   action, expiry, transaction fields, and review digest in the local page.
6. Approve pairing locally. Click **Sign locally** in Pilot, then use the local
   page's emulator controls to approve or reject the exact transaction.
7. Confirm Pilot reports a locally verified hash and `submitted: false`.

Do not disable browser security, accept a certificate warning, install a
hidden extension, expose the port publicly, or use a relay. Unsupported
browsers fail closed; use the explicit local workflow instead.

## Live and cost boundary

There is no live/mainnet mode, transaction submission, deployment, cloud
resource, paid API, or credential creation in this companion. A future change
that adds any of those requires separate owner approval and a new threat
review. A valid Speculos signature proves control of the emulator signing key;
it does not prove a physical Ledger, payment, or settlement.
