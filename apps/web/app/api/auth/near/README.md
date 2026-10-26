# NEAR wallet-control boundary

These routes are a **challenge-only integration boundary**, not a live NEP-413
login. `POST /api/auth/near/challenge` can issue a sealed, short-lived challenge
only when an upstream server has already supplied a sealed principal-to-account
authorization and the explicit runtime flags are enabled.

`POST /api/auth/near/session` currently rejects every proof with `503` and never
issues a wallet session. The web package does not declare the Borsh, Base58,
NEAR key-verification, and bounded RPC dependencies needed to verify the exact
NEP-413 payload and confirm that the submitted key is a full-access key for the
named account. Signature possession without that account-key check is not wallet
control.

Execution and transaction signing remain disabled. Enabling a live flow requires
a reviewed verifier plus durable replay-consumption wiring; challenge issuance
alone does not satisfy either requirement.
