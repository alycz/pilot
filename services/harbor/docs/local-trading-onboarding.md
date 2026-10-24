# Local trading onboarding profile

This profile is the one-time, restart-safe boundary for creating the isolated
local Testnet trading state. It shares only these artifacts with the later
trading runtime:

- `/absolute/private/pilot/harbor-secrets/harbor-local-trading.env.local`
- `.wrangler/harbor-local-trading`
- the named bearer principal and its KEK-wrapped delegate

It does not import cloud state or configuration. It listens only on
`http://127.0.0.1:8791`, requires the named bearer, disables cron and x402, and
accepts Testnet requests only. Stop every other local Harbor profile before
starting it.

## Exact onboarding surface

The profile permits only:

- `onboarding.readiness`
- `account.link`, `account.status`, `account.revoke`
- `ledger.account.info`, `ledger.account.lines`, `ledger.account.tx`
- `policy.get`, `policy.set`
- `tx.trustSet`, `tx.approvalPreflight`, `tx.execute`, `tx.submit`, `tx.status`

It deliberately excludes `tx.swap` and `tx.approvalReconcile`. The existing
trading profile remains the only runtime that exposes the six-operation trading
surface.

## XRPL transport limitation

The generic XRPL WebSocket transport does not currently apply the 4 MiB
response-body cap enforced by the JSON-RPC HTTP transport. This onboarding
profile cannot reach it: the launcher validates an exact Wrangler variable set,
the shared trading secret file accepts only `HARBOR_API_KEYS` and `HARBOR_KEK`,
and the sparse child environment drops caller-supplied XRPL endpoint variables.
The onboarding allowlist contains no WebSocket-only `path_find`, `subscribe`,
or `unsubscribe` operation, so its reachable XRPL calls use bounded JSON-RPC
HTTP.

This is a limitation of the approved profile boundary, not a generic
WebSocket response-size guarantee. Do not add an XRPL endpoint override,
WebSocket-only operation, or explicit WebSocket transport selection to this
profile until the generic WebSocket transport enforces an equivalent bound.

`account.link` creates or reuses one encrypted delegate for the authenticated
principal, approved owner, and Testnet tuple. The database uniqueness boundary
makes retries reuse that durable tuple. Under onboarding markers it never calls
a faucet. Funding the public delegate address is an explicit external Testnet
step.

The approved on-ledger permission list is exactly, in this order:

1. `OfferCreate`
2. `OfferCancel`
3. `TrustSet`
4. `AMMDeposit`
5. `AMMWithdraw`
6. `EscrowFinish`
7. `CheckCash`

## Startup and handoff protocol

1. With no local Harbor process running and the separate action-time approval
   for credential creation, run
   `npm run provision:local:trading -- --principal '<NAMED_LOCAL_PRINCIPAL>'`.
   The fixed provisioner accepts no token or KEK argument and emits neither
   secret. It creates one non-`local-dev` principal credential and a dedicated
   canonical 32-byte KEK in the exact trading secret file at mode `0600`; the
   immediate secrets directory must already be current-user-owned mode `0700`.
   It fails closed on an existing file, symlink, unsafe path, or orphaned
   staging entry and never overwrites or deletes one. An exclusive owner-only
   lock serializes concurrent provisioners; a crash residue requires explicit
   operator recovery and is never removed automatically.
   Provisioning is macOS-only and requires the macOS system Ruby/Fiddle runtime.
   A checked-in helper runs under root-owned `/usr/bin/ruby` and uses
   `acl_get_fd_np` to distinguish an empty ACL from a retrieval failure, without
   creating an executable. It requires no ACL entries on the secrets directory,
   lock, and new staging inode, and no access-granting ACL entry on any ancestor.
   Retrieval errors fail before token/KEK generation and writing; no ACL or
   security setting is modified.
2. For a first setup, confirm `.wrangler/harbor-local-trading` does not contain
   unrelated state. The launcher creates a missing root with umask `077`, runs
   only local migrations, and rejects rather than repairs an unsafe existing
   tree. A clean restart reuses the same validated state.
3. Start the onboarding profile on the fixed loopback port. It must be the only
   process using port 8791. A successful unauthenticated `GET /health` proves
   only that the Worker process is serving the reviewed loopback interface. Its
   `handoff_readiness: "not_evaluated"` field is deliberate; launcher health is
   never evidence that onboarding is complete.
4. Call `account.link` with the browser-wallet owner, `network: "testnet"`, and
   the exact seven permissions listed above.
   Retrying the same principal/owner/Testnet request reuses the encrypted
   delegate and returns the scoped unsigned `DelegateSet`.
5. Fund only the returned public delegate address by an explicit reviewed
   Testnet action outside Harbor. Use `ledger.account.info` to confirm it is
   funded. Harbor onboarding never invokes a faucet.
6. Have the approved browser owner review and sign the exact returned
   `DelegateSet`. Submit that signed blob with `tx.submit` and
   `network: "testnet"`, or submit it directly from the browser wallet. Harbor's
   direct path accepts only a `DelegateSet` matching the stored principal,
   owner, delegate, permissions, network, and link state. When Harbor relays
   it, the submission and immutable onboarding-profile status binding are
   written atomically; legacy, missing, or cross-profile bindings fail closed.
7. Use `tx.status` for a Harbor-submitted hash and call `account.status` until
   it reports an exact `active` result for the authenticated principal's owner,
   `testnet` network, stored delegate, and all seven permissions. This refreshes
   state but is not by itself a handoff attestation. Any mismatch is a failed
   onboarding, not a reason to edit local state.
8. Set the approved principal/owner/Testnet policy with `policy.set`, then read
   it with `policy.get` and require exact field-for-field equality before
   handoff. The narrow trading runtime's `tx.execute` fails closed when this
   durable policy row is missing. Build a `tx.trustSet`, execute it only after
   link activation, and confirm with the ledger read operations. Owner-sign any
   policy-required approval through the existing approval flow.
9. Call authenticated `onboarding.readiness` with the owner, literal
   `network: "testnet"`, the complete intended policy as `expected_policy`, and
   the completed TrustSet hash as `trust_set_hash`. Only `ready: true` is a
   handoff. Harbor recomputes it fail-closed from the exact reviewed runtime,
   the exact active on-ledger seven-permission link, field-for-field persisted
   policy equality (including ordered allowlists), successful delegate-key
   unwrap/address verification, a persisted executed TrustSet build whose
   immutable origin is this onboarding profile, and a fresh validated-ledger
   `tesSUCCESS` read. It also re-reads the owner's current trust line and issuer
   at the same validated ledger, requiring the TrustSet's exact currency,
   issuer, and approved limit, positive receive headroom, no line or issuer
   global freeze, and issuer authorization whenever RequireAuth is enabled. A
   legacy/null or trading-origin build, or any missing, stale, reordered,
   malformed, or unreadable fact, returns `ready: false`; the response contains
   no key material or raw internal error.
10. Stop onboarding completely. Only after the immediately preceding readiness
   response returned `ready: true`, start `npm run dev:local:trading`. That
   launcher reuses the same private D1 and secret but replaces the onboarding
   allowlist with exactly `tx.swap`, `tx.approvalPreflight`,
   `tx.approvalReconcile`, `tx.execute`, `tx.submit`, and `tx.status`.

For revocation, stop the trading runtime, restart onboarding, call
`account.revoke`, have the browser owner sign the returned empty-permission
`DelegateSet`, submit it through the scoped direct `tx.submit` path, and poll
`account.status` until the link is durably `revoked`. Do not run onboarding and
trading simultaneously.

No secret file, bearer credential, KEK, delegate, faucet request, signature, or
network action is created merely by starting this profile. Running the separate
one-shot provisioner and every browser-wallet signature remain explicit
operator actions.
