# MM2 validator kernel

This directory is the isolated, fail-closed implementation of the Mastercard
Level 3 validation order:

1. Web Bot Auth identity
2. Mastercard intent plus Verifiable Intent chain
3. XRPL AP4M-Agent credential
4. XRPL payment settlement

The kernel deliberately accepts concrete cryptography and ledger behavior only
through `ValidatorDependencies`. Tests use public deterministic fakes; they are
not evidence that a Web Bot Auth signature, a Python reference VI chain, an XRPL
credential, or a Testnet payment was verified live.

`ChallengeContext` is resolved from trusted catalog and stored 402 state. It
keeps USD authorization (`price_usd_cents`) distinct from the exact settlement
asset, issuer, and value. The adapter must never fill it from retry headers.

`InMemoryAtomicNonceStore` is only for isolated tests/local mock mode.
`SQLiteAtomicNonceStore` provides an injected, durable single-host option whose
transactional `claim` is atomic across workers sharing the database file.
Multi-host deployments must inject another implementation of `NonceStore`; a
process-local set is not an acceptable replay guard.
The directory loader must honor `DirectoryFetchPolicy`: HTTPS origin discovery,
the fixed well-known path, no redirects, at most 16 KiB and four keys, and a
timeout no greater than two seconds. The validator rejects policy objects that
try to expand any of those ceilings.

The validator parses the three raw Web Bot Auth fields in the exact dictionary
form emitted by MH6, reconstructs the RFC 9421 signature base, and verifies the
selected Ed25519 public JWK with `cryptography`. The application environment
must package that library; absence fails closed as `WBA_CRYPTO_UNAVAILABLE`.
The public interoperability fixture is copied byte-for-byte from MH6 as
`tests/fixtures/wba-mh6-mm2-v1.json` (SHA-256
`d66471e7a4c1776e9ea8ef71f6c3f0fb7ec2a03b5c4ba016008bac64d29bcbc8`).

The Harbor MH4 public cross-language fixture is also copied byte-for-byte as
`tests/fixtures/ap4m-mh4-mm2-v1.json` (SHA-256
`9b01e30bb77d7071d6431a8fcd530f7ac4bfefa61d1d28b886a00acde9eacb3b`).
Offline tests verify its public P-256 signatures, selective-disclosure links,
checkout digest, exact t54 challenge, and paid-retry header projection. Its
`DEADBEEF` payment is explicitly synthetic and unvalidated, so those tests are
wire interoperability evidence only, not an XRPL settlement Check.

The pinned reference verification subset is vendored under
`_vendor/verifiable_intent` from v0.1.0 commit
`1dc3d4189512041fb3d0f8348fe100dfe25ced91`; provenance, exact source hashes,
and its Apache-2.0 license are retained there. `PinnedReferenceViVerifier`
wraps that code with bounded fail-closed parsing and projects only the AP4M
claims required by the validator. The independent pinned public L1/L2 fixture
is byte-identical at `tests/fixtures/vi-ap4m-reference-v0.1.json` (SHA-256
`9c25025bcc78c1889fde7391c44be4203e43271486f9a428de3fe60d9a4eada1`).

The MM1 adapter keeps its in-memory mock store by default. A separately
injected `SQLiteChallengeStore` now preserves challenge context and atomically
coordinates acquisition across local workers. Its completion record is
TTL-bounded and keyed by the exact challenge state, validated intent ID, and
XRPL transaction hash; only that exact triple can recover the bounded cached
merchant response without resubmitting settlement. The store rejects cached
signature, VI, transaction-blob, payment-token, private-key, and secret fields.
Processing uses a fenced lease keyed to that same intent/transaction identity.
A validated response is durably checkpointed before completion; a stale exact
retry may take over the lease and promote the checkpoint without calling the
payment transport again, while concurrent non-owners and changed keys fail.
Multi-host runtime wiring still requires an external durable implementation.

The serialized MM1 adapter now:

- map the HTTP request to `MerchantValidationRequest` without weakening its
  exact field rules;
- resolve `ChallengeContext` by its opaque server-side state handle;
- copy the three raw signature header values without normalization and supply
  the MH6 directory loader/response metadata; reject duplicate signature
  fields and derive authority/path from the trusted raw request target rather
  than forwarded headers;
- supply the versioned L1/L2/L3b bundle produced by Harbor;
- require the pinned VI verifier to prove the P-256 L3 signer from the L2 agent
  `cnf`; Web Bot Auth remains a distinct Ed25519 identity proof whose directory
  credential subject is bound separately to the decoded payer and CredentialIDs;
- carry the trusted L3a digest in durable prepared state (it is intentionally
  absent from paid retry headers);
- append the four returned events in their existing order, without tokens,
  transaction blobs, headers, private material, or PII.

Before the package can be marked complete, the deployed runtime must:

- inject the persistent nonce and challenge stores appropriate to its topology
  (the SQLite implementations are deliberately not auto-wired);
- issue and persist trusted expected L2 and L3b nonces with the challenge, then
  supply them to the pinned VI verifier rather than accepting header echoes;
- inject the pinned VI verifier with approved issuer and agent public keys;
- decode XRPL payments and read credentials through the approved Testnet
  transport;
- run payment submission only with `LIVE=1` and the live gate green;
- retain idempotent transaction-hash lookup semantics in the real payment
  transport so a pre-checkpoint crash cannot resubmit a different payment.

Until those dependencies exist, `identity_mode="skipped"` is the visibly yellow
Tier-1 fallback and any missing verifier or transport fails closed.

MM2 remains partial. The released MH4 merchant presentation now discloses the
minimal payment + merchant + checkout + item set, and the pinned reference
verifier proves `l2_reference_binding`, agent-key identity, L3b audience/nonce,
and structural chaining against it. Runtime still lacks a trusted source for
the expected L2 mandate ID and L3b nonce, deployment wiring for the durable
stores, an approved XRPL decoder/credential reader/payment transport, and a
real signed submitted payment fixture. L3a remains intentionally outside
merchant transport and is not required or projected from a paid request.
