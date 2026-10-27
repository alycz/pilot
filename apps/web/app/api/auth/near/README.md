# NEAR wallet-control boundary

These routes are a default-off **wallet-control proof boundary**, not a general
login or transaction-signing flow.

`POST /api/auth/near/bootstrap` is the narrow hosted bootstrap path. It requires
same-origin JSON with `bootstrap: true`, an exact `near:mainnet` account claim,
an active server-sealed Pilot wallet session, verify-mode wallet proof, durable
replay storage, and `PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED=true`. The server
derives an opaque principal from the wallet session; the browser cannot choose
it. The resulting five-minute preauthorization contains only
`near.intents.approval.review`. It is bound to the deployment, Pilot wallet
account/network, exact wallet-session expiry, claimed NEAR account, and server
secret. Changing or renewing the Pilot wallet session invalidates it.

`POST /api/auth/near/challenge` then issues a sealed, short-lived NEP-413
challenge for that exact principal and NEAR account. Wallet-bound principal
authorizations are rejected if the active Pilot wallet session is missing or no
longer matches.

In `verify` mode, `POST /api/auth/near/session` reconstructs the exact NEP-413
tagged Borsh payload (with no callback URL), verifies its SHA-256/Ed25519
signature, and queries the fixed NEAR mainnet RPC for the exact account/key with
`finality: final`. Only an exact `FullAccess` permission is accepted. The proof
is then consumed once through Harbor's dedicated, atomic D1-backed
`near-wallet-auth` namespace. The opaque replay scope binds the Pilot principal,
NEAR account, network, authorization ID, and recipient; only a nonce digest is
sent to Harbor.

After the exact full-access-key proof and durable nonce consumption succeed,
the session route replaces a bootstrap preauthorization with a 15-minute sealed
authorization limited to approval review, executable-quote review, status, and
owner-funded reservation. No scope upgrade occurs before proof consumption.

Proof verification requires migration `0019_near_wallet_proof_replay.sql` and
the separately authenticated hosted-state route. Missing configuration, RPC,
or replay storage fails closed. `challenge-only` mode still rejects proof
submission. A successful proof clears the challenge. The scoped authorization
is not a funding proof, transaction signature, access key, or settlement record.
Transaction building, signing, broadcasting, provider calls, and funding remain
outside these routes.
