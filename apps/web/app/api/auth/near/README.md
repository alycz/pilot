# NEAR wallet-control boundary

These routes are a default-off **wallet-control proof boundary**, not a general
login or transaction-signing flow. `POST /api/auth/near/challenge` can issue a
sealed, short-lived challenge only when an upstream server has already supplied
a sealed principal-to-account authorization and the explicit runtime flags are
enabled.

In `verify` mode, `POST /api/auth/near/session` reconstructs the exact NEP-413
tagged Borsh payload (with no callback URL), verifies its SHA-256/Ed25519
signature, and queries the fixed NEAR mainnet RPC for the exact account/key with
`finality: final`. Only an exact `FullAccess` permission is accepted. The proof
is then consumed once through Harbor's dedicated, atomic D1-backed
`near-wallet-auth` namespace. The opaque replay scope binds the Pilot principal,
NEAR account, network, authorization ID, and recipient; only a nonce digest is
sent to Harbor.

Proof verification requires migration `0019_near_wallet_proof_replay.sql` and
the separately authenticated hosted-state route. Missing configuration, RPC,
or replay storage fails closed. `challenge-only` mode still rejects proof
submission. A successful proof clears the challenge and returns a one-response
wallet-control confirmation; it does not issue a reusable NEAR login cookie.
Execution and transaction signing remain disabled.
