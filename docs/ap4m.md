# Mastercard AP4M on XRPL

This runbook covers Pilot's mock-first Mastercard Agent Pay for Machines
(AP4M) demonstration and its Harbor and merchant-service dependencies. The
payment rails are XRP Ledger Testnet rails. The build does not call a
Mastercard AP4M or Agent Pay API, does not process card data, and must not be
described as Mastercard-certified or Mastercard-compliant.

Unless an evidence file records an observed Testnet result, every result in the
default lane is labelled mock/offline evidence only. Source review, fixtures,
typecheck, and unit tests do not prove a credential, payment, claim, redemption,
or revocation occurred on a ledger.

## What the demo proves

The demo answers five authority questions in sequence:

1. **Human:** Mastercard Open Finance supplies a mock or sandbox account-owner
   verification and balance snapshot. Pilot sends only a masked owner display
   to the browser and stores hashes rather than raw PII.
2. **Intent:** the owner authorizes one DEFERRED Verifiable Intent mandate. Its
   constraints bind the agent public key, allowed merchants and products,
   per-payment, daily, and lifetime limits, and expiry.
3. **Agent:** a Demo Network issues an XRPL `AP4M-Agent` credential. It is a
   labelled stand-in for the network-issued credential in a production design.
4. **Merchant:** Web Bot Auth identifies Harbor's HTTP caller. The merchant then
   applies the Mastercard Level 3 order: identity, intent, credential, payment.
5. **Settle:** an exact payment validates on XRPL Testnet, or cumulative
   payment-channel claims are accepted off-ledger and later redeemed in one
   XRPL transaction. Receipts preserve the mandate, intent, L3 digests, payment
   proof, validation result, and ledger reference as dispute evidence.

The partner-gated Mastercard AP4M rail remains an explicit, disconnected seam.
It is not replaced with a fake Mastercard payment.

## Actors and trust boundaries

| Actor | Responsibility | Private material boundary |
| --- | --- | --- |
| Owner browser | Holds the XRPL wallet key and a non-extractable ES256 VI device key; signs the bounded setup approval | Owner XRPL material stays in the wallet or Testnet-only browser signer; the VI device private key stays non-extractable in browser IndexedDB |
| Pilot server | Runs Open Finance session routes, typed agent tools, receipt UI, and vault writers | Open Finance credentials remain server-side; Pilot never receives an owner XRPL key or the VI agent private key |
| Harbor | Enforces Policy ∩ mandate, mints L3 artifacts, signs exact payer transactions or channel claims, and stores receipts | Mandate-agent, claim, Web Bot Auth, delegate, and payer keys are encrypted at rest and never enter model context |
| Demo Network | Issues VI L1 and XRPL `AP4M-Agent` credentials in the Testnet demo | Test-only issuer material is server-side and external to Git |
| Demo merchants | Validate identity, intent, credential, and payment; serve typed data; redeem channel claims | Testnet merchant material is external to Git and never returned by an API |

No AP4M transaction is allowed on Mainnet. `Payment`,
`PaymentChannelCreate`, and `PaymentChannelFund` are never added to Harbor's
owner-delegation permissions: setup remains owner-signed, while Harbor may sign
only for its own bounded payer or claim keys.

## End-to-end flow

### Onboarding and one approval

1. Pilot starts Mastercard Open Finance in `mock` or `sandbox` mode, obtains an
   account summary, masks the owner, and proposes a budget.
2. The Demo Network issues VI L1 to the browser's public device key and creates
   the Testnet `AP4M-Agent` credential for the owner and Harbor payer.
3. `mandate.prepare` creates Harbor's per-mandate agent key and per-merchant
   claim keys. It returns an unsigned all-or-nothing XRPL Batch containing
   `CredentialAccept` and one `PaymentChannelCreate` per merchant. The safe
   fallback is a set of sequential owner-signed transactions.
4. The browser signs VI L2 with its non-extractable key, binds the prepared
   agent key and constraints, and places the L2 digest in the Batch memo.
5. The wallet signs the exact rendered Batch without submitting it. Pilot
   relays it through Harbor, and `mandate.register` requires the Batch and every
   inner transaction to be validated before the mandate becomes `ACTIVE`.
6. Harbor's own payer accepts its Testnet credential.

### Machine-speed purchase

1. Pilot calls `ap4m_purchase` with a fixed merchant and SKU. The server binds
   the mandate, owner, network, and idempotency key; the model cannot supply a
   URL, price, payment header, key, token, or raw merchant content.
2. Harbor requires both gates to pass before minting L3 or reserving spend:
   the existing Policy and the mandate's status, expiry, merchant, SKU,
   per-payment, daily, lifetime, and `ap4m_enabled` rules.
3. Harbor creates a five-minute Mastercard-shaped intent object plus L3a and
   L3b Verifiable Intent artifacts, then signs the outbound request with Web
   Bot Auth.
4. The merchant returns an x402 challenge for either `xrpl-paychan` or `exact`.
   Harbor validates the challenge against its registry and stored price.
5. For a channel purchase, Harbor signs a cumulative claim that cannot exceed
   the channel amount. For an exact purchase, its own Testnet payer signs the
   bound XRPL payment with the accepted Credential ID.
6. The merchant verifies agent identity → intent → credential → payment in that
   order and returns only schema-validated typed data plus
   `intent_validation`. Raw merchant text never enters the model.
7. Pilot renders and stores the bounded receipt chain: **Mandate → Intent → L3
   → Payment → Ledger**.

### Settlement and safety

- A merchant accepts monotonically increasing cumulative channel claims
  off-ledger. `Settle now` redeems the highest accepted balance in one
  `PaymentChannelClaim`; earlier claims are covered by that cumulative value.
- Credential-gated exact payments validate individually on XRPL Testnet.
- An over-budget request is blocked by named Harbor rules before an L3 or claim
  is created.
- An altered or expired intent fails merchant validation.
- An uncredentialed rogue payer is expected to be rejected by the ledger; only
  a recorded Testnet result may establish the exact engine code.
- Revocation marks the mandate `REVOKED` and deletes the demo credential. The
  next purchase must fail; a channel close remains an owner-visible ledger
  action.

## Mandatory stand-in labels

Use these strings exactly in UI, receipts, screenshots, and demo narration:

- `Mastercard Open Finance · sandbox`
- `Mastercard Open Finance · mock`
- `Demo Network — Mastercard's role in production`
- intent prefix `demo-intent-…` with tooltip `Mastercard-generated in production`
- `Verifiable Intent v0.1 · verified with Mastercard's reference implementation`
- `Validation flow from Mastercard's Level 3 Agentic Commerce guide · payment object: XRPL`
- `ap4m-sandbox · requires Mastercard early-access credentials`
- `XRPL Testnet`

Never use “Mastercard certified”, “Mastercard compliant”, “paid with
Mastercard”, a mock agentic token, a card-number form, or a card logo that could
imply a Mastercard-network payment.

## Mock-first local checks

The default lane requires no Mastercard credentials, wallet, signing, faucet,
or ledger access:

```bash
pnpm install --frozen-lockfile
MASTERCARD_OF_MODE=mock HARBOR_MOCK=1 pnpm typecheck
MASTERCARD_OF_MODE=mock HARBOR_MOCK=1 pnpm test
MASTERCARD_OF_MODE=mock pnpm tsx scripts/mastercard/of-smoke.ts
```

The Open Finance smoke command prints only non-secret identifiers, the mock
Data Connect URL, a masked owner, and the proposed budget.

Run the merchant's offline suite in an external temporary environment:

```bash
AP4M_TEST_VENV="$(mktemp -d "${TMPDIR:-/tmp}/pilot-ap4m.XXXXXX")"
python3 -m venv "$AP4M_TEST_VENV"
"$AP4M_TEST_VENV/bin/pip" install -e 'services/ap4m-merchants[test]'
"$AP4M_TEST_VENV/bin/pytest" -q services/ap4m-merchants
"$AP4M_TEST_VENV/bin/python" services/ap4m-merchants/setup_testnet.py --dry-run
```

Dependency installation may use PyPI. The tests and `--dry-run` do not sign,
fund, submit, or contact a ledger and are not live-payment evidence.

## Full local Testnet demo

Wave 4 combines the orchestration under `scripts/ap4m-demo/`:

```bash
pnpm tsx scripts/ap4m-demo/reset.ts
bash scripts/ap4m-demo/local.sh
pnpm tsx scripts/ap4m-demo/run-headless.ts
pnpm tsx scripts/ap4m-demo/run-headless.ts
```

`reset.ts` is a Testnet-only, separately authorized operation. It prepares
public demo state and must print public addresses only. `local.sh` starts the
dedicated Harbor AP4M profile, Pilot, the merchant service, and the demo market
maker on their assigned ports. It must not replace, reuse, or interrupt the
preserved trading, x402, or merchant processes described by the conductor.

Each headless run performs onboarding, nine purchases, the four safety moments,
and settlement. A run counts only when a newly generated JSON evidence file under an ignored private output directory
contains the relevant Testnet transaction hashes and actual verdicts. Mocked
success is never a substitute for a required `LIVE=1` Check.

## Switching Open Finance from mock to sandbox

The application path is identical in both modes; only the server transport
changes.

1. Austin creates the Mastercard Developers/Open Finance sandbox project and
   places the Partner ID, Partner Secret, and App Key in the externally managed
   Pilot secrets file. Codex must not request, read, print, copy, or configure
   those values.
2. The operator selects `MASTERCARD_OF_MODE=sandbox`. The related server-only
   variable names are `MASTERCARD_OF_PARTNER_ID`,
   `MASTERCARD_OF_PARTNER_SECRET`, and `MASTERCARD_OF_APP_KEY`;
   `MASTERCARD_OF_BASE_URL` defaults to the documented Finicity endpoint.
3. From an eligible egress region, run:

   ```bash
   MASTERCARD_OF_MODE=sandbox pnpm tsx scripts/mastercard/of-smoke.ts
   ```

4. Complete the human Data Connect step when the script pauses. The script
   resumes with an account ID, masked owner, and proposed budget; it must not
   print tokens, credentials, or raw owner PII.
5. Confirm the demo chip reads `Mastercard Open Finance · sandbox`. If the
   sandbox is unavailable, return to `mock` and retain the exact mock label.

Never paste sandbox values into a command line, issue tracker, chat, screenshot,
status file, or repository. Open Finance credentials and tokens remain
server-side.

## Event-day gates

The following checks remain pending until Austin supplies the event-only
accounts and the conductor authorizes the live lane. Complete them on Testnet,
never Mainnet:

- Open Finance sandbox token → testing customer → Data Connect → accounts →
  owner smoke from an eligible egress region.
- `CredentialCreate`, `CredentialAccept`, credential lookup, DepositAuth, and
  credential-gated exact-payment behavior match the recorded XRPL assumptions.
- The setup Batch validates and every inner transaction reports `tesSUCCESS`;
  otherwise test the documented sequential owner-sign fallback.
- One exact RLUSD or labelled `tUSD` fallback purchase validates with
  `CredentialIDs` present.
- Nine channel claims are accepted without nine Harbor ledger transactions,
  followed by one validated merchant redemption covering the cumulative amount.
- Web Bot Auth and the L1/L2/L3 chain verify across Harbor and the merchant;
  all merchant failure branches remain fail-closed.
- The rogue-agent attempt records its actual ledger rejection and hash; do not
  report the expected engine code before it is observed.
- Revocation deletes the credential and blocks the next purchase at the
  mandate gate.
- Both consecutive `run-headless.ts` runs are green and their newly generated evidence JSON is retained only in the ignored private output directory.

Do not turn on `LIVE=1`, start the AP4M local stack, fund a Testnet account, or
touch a wallet until the conductor has confirmed the dedicated workspace,
ports, live integration gate, and external secrets handoff. The
`ap4m-sandbox` rail remains disconnected even when Open Finance sandbox mode is
active.

## Judge Q&A

**What is integrated with Mastercard?** At the event, the intended live
integration points are Open Finance sandbox and Mastercard Developers
discovery. Claim them as live only after their event-day Checks pass.
Verifiable Intent uses the pinned Mastercard/Google reference implementation,
the merchant follows the Level 3 guide, and `ap4m-sandbox` is a clearly labelled
future seam.

**Who issues credentials in production?** Mastercard's AP4M model calls for
network-issued credentials; an issuer or a partner such as t54 Labs can fill
that role. The demo uses `Demo Network — Mastercard's role in production`.

**What guarantees channel settlement?** The channel's locked collateral and
`SettleDelay` bound the XRPL claim. That complements, but does not replace,
Mastercard's own guarantee.

**Why XRPL?** Native credentials, DepositPreauth, and payment channels provide
the authority and collateral primitives without application contracts. RLUSD,
the built-in DEX, and fast finality support preferred-currency settlement.

**What happens to a rogue or revoked agent?** Harbor stops minting L3 artifacts
or claims after mandate revocation, credential deletion removes ledger-level
authorization for exact payments, and the owner can close remaining channels.

## Sources and provenance

- [Mastercard Open Finance US](https://developer.mastercard.com/open-finance-us/documentation/)
- [Mastercard Developers MCP and Agent Toolkit](https://developer.mastercard.com/ai/)
- [Mastercard Level 3 Agentic Commerce guide](https://developer.mastercard.com/merchant-cloud/documentation/tutorials-and-guides/agentic-commerce-guide/23/index.md)
- [Mastercard Agent Pay for Machines](https://www.mastercard.com/us/en/business/artificial-intelligence/mastercard-agent-pay/agent-pay-for-machines.html)
- [Verifiable Intent](https://github.com/agent-intent/verifiable-intent), with
  the verifier subset pinned to commit
  `1dc3d4189512041fb3d0f8348fe100dfe25ced91` and documented under
  `services/ap4m-merchants/validator/_vendor/verifiable_intent/PROVENANCE.md`
- [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421)
- [XRP Ledger Credentials (XLS-70)](https://xls.xrpl.org/xls/XLS-0070-credentials.html),
  [DepositPreauth](https://xrpl.org/depositpreauth.html),
  [Payment Channels](https://xrpl.org/docs/concepts/payment-types/payment-channels),
  and [Batch](https://xrpl.org/docs/references/protocol/transactions/types/batch)
- [x402 on XRPL](https://xrpl.org/docs/agents/agentic-payments-x402)
