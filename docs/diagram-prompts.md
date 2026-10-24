# Diagram prompts

These prompts are designed for Claude or another visual-design collaborator.
They ask for diagrams only; they do not authorize code, infrastructure,
credentials, wallets, or ledger actions. Ask for editable SVG or Mermaid plus a
PNG preview, and verify every label against the repository before publishing.

## 1. Product journey

```text
Create a polished product-journey diagram for “Pilot,” an XRP Ledger agent
interface that keeps owner keys in the user’s wallet. Show a left-to-right flow:

Research in chat → typed intent → policy check → transaction build → either
delegated Harbor execution OR exact wallet sign-only approval → relay →
validated ledger result → Portfolio and Markdown Memory update.

Use two clearly separated approval branches. Mark “build” as non-execution and
mark “validated” as the only completed ledger state. Show Chat, Map, Portfolio,
Memory, and Onboarding as the five user-facing surfaces. Use a dark charcoal
background, warm off-white type, restrained electric violet and aqua accents,
rounded cards, thin connectors, and accessible high contrast. Avoid crypto
clichés, coin photography, neon gradients, and claims of guaranteed yield.

Include a small legend distinguishing presentation/fixture evidence from live
validated evidence. Deliver an editable SVG and a 1600×900 PNG.
```

## 2. Trust and security boundaries

```text
Design a technical trust-boundary diagram for Pilot and Harbor.

Zones:
1. Browser: user, Chat/approval UI, owner wallet, sign-only transaction review.
2. Pilot Next.js server: wallet-bound request proof, typed intent, policy/card
   orchestration, server-only Harbor client, wallet-scoped Markdown vault.
3. Harbor: authenticated reviewed operation allowlist, transaction build,
   delegated execution, signed-blob relay, validated status, and a separate
   isolated x402-only process.
4. XRP Ledger Testnet/Devnet.

Show that owner keys never enter the Pilot server or Harbor. External-wallet
owner keys remain inside the wallet; the isolated test-only development signer
keeps its owner key browser-local and never sends it to the server. Depict
Harbor as a separate signing trust boundary that stores encrypted
limited-purpose delegate keys and standalone payer keys, then unwraps them only
for authorized signing. These Harbor keys are not owner keys and never enter
the browser or model. Harbor API keys, model keys, and session secrets never
enter browser code; the model has no signing tool; Mainnet execution is
prohibited; and a signed-pending attempt is never automatically replayed.
Depict exact-origin and profile boundaries around the local isolated pair, but
show ordinary Harbor operations at .2:8791 and only x402.pay at .2:8792 with a
different named principal, bearer, payer, KEK, and D1 state. Do not include
secret values. Use solid arrows for data, dashed arrows for authorization, and
red stop markers for forbidden crossings. Deliver Mermaid source plus an
editable SVG.
```

## 3. Approval and recovery state machine

```text
Create a rigorous state-machine diagram for Pilot’s dedicated
official-Testnet-RLUSD `xrpl_execution_v2` acquisition path. Do not generalize
these states to every owner-approved transaction.

Required states and transitions:
fresh build → rendered for review → approval preflight → wallet sign-only →
signed_pending → first relay attempt → validated OR remains pending.

Show fail-closed branches for expired approval, stale ledger window, sequence
change, balance-invariant change, malformed/unavailable proof, and binding or
digest mismatch. A refresh creates a new build/revision/digest and returns to
rendered-for-review; it never auto-signs. Recovery may burn an expired unsigned
tuple only after complete reviewed non-inclusion proof, then the next action is
“request fresh build.” A possibly signed or relayed attempt is non-replayable.

Emphasize that “pending,” “expired,” and “requested” are not validated ledger
outcomes. Use compact labels, guard conditions on edges, and separate happy,
blocked, and recovery colors. Deliver Mermaid source and an accessible SVG.
```

## 4. Local development and acceptance topology

```text
Create a two-panel environment topology for Pilot.

Panel A — Credential-free frontend fixture lane:
- Playwright owns 127.0.0.1:3004.
- Deterministic HTTP fixtures and mock Harbor data.
- No credentials, wallet, signing, funding, external model, or XRPL endpoint.
- Eight flows are presentation/contract evidence only.

Panel B — Isolated local Testnet acceptance slot (paused):
- Browser → Pilot at exactly 127.0.0.2:3003.
- Pilot server → Harbor at exactly 127.0.0.2:8791 with raw Host
  127.0.0.2:8791.
- Harbor onboarding and trading profiles share only their dedicated local D1
  and credential identity and must run sequentially, never concurrently.
- Pilot server → dedicated x402-only Harbor at exactly 127.0.0.2:8792 with raw
  Host 127.0.0.2:8792, using a second server-only named capability.
- Only x402.pay may cross the .2:8792 boundary. The x402 process has its own
  credential, KEK, payer, D1 state, and allowlist; all ordinary operations stay
  on .2:8791.
- The x402 process calls only the reviewed merchant at 127.0.0.1:8000.
- Startup is paused for an administrator-managed macOS loopback alias handoff.
- Original 127.0.0.1 session/tab/state remains untouched.
- The source-reviewed .2 x402 capability does not reuse the legacy standalone
  .1 x402 service. Legacy credentials, state, payer, and evidence remain
  separate preservation targets.

Clearly label that passing CI is not live acceptance, public onboarding is not
available, and no live trade, paid x402 request, or revocation is claimed. Use
matching visual language across both panels and deliver editable SVG plus
1600×900 PNG.
```
