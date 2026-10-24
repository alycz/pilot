# Isolated local x402 v1 contract

Status: offline source and fixture tests only. This document is not evidence of
a paid request, a funded payer, a running service, or live Testnet acceptance.

## Fixed topology

The dedicated x402-only Harbor process is `http://127.0.0.2:8792`. Its raw
`Host` must be `127.0.0.2:8792`; forwarding metadata and alternate loopback
spellings are rejected. The legacy x402 process at `127.0.0.1:8791` and the
isolated trading/onboarding processes at `127.0.0.2:8791` are unchanged.
Wrangler DevTools is separately pinned to `127.0.0.2:9232`, avoiding the
trading process's inspector endpoint.

The process accepts only `x402.pay`, requires one named bearer principal, uses
Testnet and QuickJS, and keeps mainnet and cron disabled. Its D1 lives at one
operator-approved, external, absolute state root. There is no checkout-relative
fallback and no checked-in active destination. Trading markers and reuse of the
isolated trading state root are forbidden. The fixed merchant remains the
reviewed loopback merchant at `127.0.0.1:8000`, with `pay_to` pinned to the
exact Testnet classic address `rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr`;
caller-selected targets and redirects remain unavailable. The isolated
provisioner retains the public `--merchant-pay-to` confirmation input but
accepts only that exact address.

The isolated public `x402.pay` contract fixes both `max_price_drops` and the
accepted `compare` challenge amount to exactly 5,000 drops. Values below or
above 5,000 are rejected before the payment service can run. Generic and
legacy `.1` requests retain their original strict five-field shape and
ceiling-based price negotiation; the exact-price binding activates only with
the reviewed isolated-v1 marker pair. The engine otherwise retains
the fixed `compare` resource, XRP-only challenge, 100-drop fee ceiling, policy
limits, durable invoice and idempotency binding, payer quarantine, and
ambiguous settlement reconciliation.

The isolated profile's Wrangler config points only to
`migrations-profile-x402-isolated-v1`. That frozen directory contains exactly
the reviewed `0001` through `0007` x402 migrations. Before any credential or
state access, launch and provisioning require an exact entry set of regular,
single-link files that are byte-identical to their canonical sources in
`migrations-local-x402/` and match their reviewed SHA-256 digests. Provisioning
requires canonical non-symlink source and profile directories, opens migration
files without following symlinks, and checks stable descriptor identities
before and after every read. It revalidates the profile again immediately
before migration application.
Missing, additional, linked, or byte-drifted files fail closed.
`0008_ap4m_shared_runtime.sql` remains available only through the
combined AP4M profile's existing migration directory; it is not an isolated
x402 v1 migration.

The mutation-bound isolated request has exactly six fields:

```json
{
  "owner": "r...",
  "network": "testnet",
  "resource": "compare",
  "max_price_drops": "5000",
  "pay_to": "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr",
  "idempotency_key": "request-id"
}
```

The old strict five-field Harbor contract rejects `pay_to`. The reviewed
isolated profile requires it, while legacy and generic profiles reparse the
original strict five-field shape and reject it. This makes mixed-version
execution fail before reservation or signing rather than relying on a health
string or other cosmetic capability signal.

## Provisioner source (execution deferred)

No credential, KEK, payer wallet, funding request, signature, or ledger action
is created or read during offline verification. The checked-in
`provision:local:x402:isolated:v1` command is implemented and covered by mocked
filesystem, cryptography, faucet, ledger, and D1 tests, but it was not run. Its
fixed private outputs are limited to:

- `${HARBOR_PRIVATE_SECRETS_ROOT:?set HARBOR_PRIVATE_SECRETS_ROOT}/harbor-local-x402-isolated-v1.env.local`
- `${PILOT_PRIVATE_SECRETS_ROOT:?set PILOT_PRIVATE_SECRETS_ROOT}/pilot-isolated-x402-capability-v1.env.local`
- one explicitly approved external state root, bound into the Harbor credential
  and its immutable root marker
- D1 name `harbor-local-x402-isolated-v1-only`
- a new x402-only principal and token that are not the isolated trading principal
- one dedicated Testnet payer that is not an owner, merchant, or active trading delegate

The command applies only the exact checked-in isolated D1 migrations. It never
opens legacy `.wrangler/harbor-local-x402` state. It accepts no credential, KEK,
seed, or private key input. Both output files are published directly at their
fixed final paths with owner-only mode, `O_EXCL`, and no symlink, hard link,
rename, or overwrite. The Pilot capability file contains only the isolated
named bearer; it neither reads nor copies the existing Pilot session secret or
trading credential. Existing matching files are reused without regeneration.
An existing Harbor credential with any other merchant binding fails closed
before migration or state access; the provisioner has no migration, overwrite,
or rotation path. A verified Harbor-credential-only interruption may complete
publication of the missing Pilot capability only in `resume` mode and only
when that Harbor credential, its exact bound state root, marker, D1 identity,
and schema all match. A Pilot-only, mismatched, or otherwise partial credential
state fails closed. The payer must have a validated
Testnet balance between 2,100,100 and 1,000,000,000 drops, inclusive. Durable
pre-faucet intent and payer-state reconciliation prevent a second faucet call
after an ambiguous or interrupted attempt.

The existing `provision:local:x402` command remains legacy `.1` provisioning
and retains its generic valid-classic-address merchant input; it must not be
reused for this profile. Actually running the isolated command
would create persistent access, generate a payer, request Testnet funding, and
write private files, so it still requires later explicit approval and operator
presence. The reviewed form, with public placeholders only, is:

```text
npm run provision:local:x402:isolated:v1 -- --provision-testnet-payer --state-mode initialize --state-root '<APPROVED_ABSOLUTE_EXTERNAL_ROOT>' --principal '<NEW_X402_ONLY_PRINCIPAL>' --trading-principal '<EXISTING_ISOLATED_TRADING_PRINCIPAL>' --owner '<AUTHENTICATED_PILOT_OWNER_PUBLIC_ADDRESS>' --merchant-pay-to 'rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr' --trading-delegate '<ACTIVE_ISOLATED_TRADING_DELEGATE_PUBLIC_ADDRESS>'
```

Use `--state-mode resume` with the same bound root only after initialization
completed and its immutable marker and full D1 state validate. Resume never
creates a root or applies a migration.

Before that command, an operator must capture and review the unmodified public
`data` results from `account.status` and `onboarding.readiness`, then materialize
them at the fixed input path
`${HARBOR_PRIVATE_EVIDENCE_ROOT:?set HARBOR_PRIVATE_EVIDENCE_ROOT}/pilot-isolated-trading-delegate-v1.json`
using the shape in
`config/pilot-isolated-trading-delegate-evidence-v1.json.template`, mode `0600`
with an empty native ACL. The provisioner requires an active Testnet account
link, all readiness checks true, exact reviewed permissions, concordant owner
and delegate, and positive validated-ledger evidence. It validates consistency;
it does not claim that an arbitrary address or fabricated JSON proves a chain
relationship. Obtaining and approving fresh evidence remains an operator step.

Every public CLI value and this evidence are validated before migrations, D1
open, or secret publication. The generated/resumed x402 payer must differ from
the authenticated owner, merchant, and evidence-bound active trading delegate.
Before those effects, the provisioner reads the fixed isolated-trading
credential through its existing private-path validation, derives only its
named principal, and requires that principal to equal `--trading-principal`
and differ from the requested x402 principal. Pilot also compares both named
principals and both bearer tokens before constructing either client.

## External state lifecycle

The provisioner requires both `--state-mode initialize|resume` and
`--state-root <ABSOLUTE_EXTERNAL_ROOT>`. The value is public configuration, not
a secret, but it is security-sensitive: it is recorded in the strict Harbor
credential and in an owner-only immutable state marker together with the
profile contract, Testnet network, signing profile, D1 name, and D1 ID. Those
bindings must agree on every reuse.

`initialize` is the only mode allowed to create the absent leaf directory or
apply the checked-in isolated migrations. Its parent must already exist with
private ownership and permissions. Initialization validates the resulting real
Miniflare D1 layout and complete x402 schema before publishing the marker. It
does not replace, empty, rename, or repair an existing root.

`resume` requires the root, marker, Miniflare D1 metadata, sole direct D1
payload, database integrity, and final migrated schema to exist already. It
runs no migration and creates no replacement. The launcher is resume-only: it
reads the fixed credential, takes the bound root from that credential, verifies
the marker and D1 again, regenerates the catalog, revalidates the state, and
only then may start the Worker. A missing, partial, moved, linked, permission-
unsafe, checkout-relative, legacy, trading, wrong-profile, wrong-D1, corrupt,
or incomplete state fails closed before Worker startup.

No real destination is approved or activated by this documentation. The path
proposed for later operator review is
`${HARBOR_PRIVATE_STATE_ROOT:?set HARBOR_PRIVATE_STATE_ROOT}/harbor-local-x402-isolated-v1`.
Creating its parent or leaf, writing its marker, applying migrations, creating
credentials or a payer, requesting faucet funds, or starting a service remains
a separately approved action-time operation.

Secret directories, new inodes, reused inodes, and launcher reads all use the
same native fd-based macOS ACL inspector as the accepted trading provisioner.
Access-granting ACLs fail before credential generation or reuse.

### Crash and manual-recovery policy

The provisioner and launcher hold an exclusive owner-only lease for the whole
state lifecycle. A normal exit releases it. A concurrent initialize, resume,
or launcher attempt fails closed; none waits, steals the lease, or creates a
second state tree.

| Interruption point | Automatic result | Operator recovery boundary |
| --- | --- | --- |
| Before leaf creation | No root exists; a later explicitly approved `initialize` may begin again | Revalidate the same approved destination and inputs |
| After leaf creation but before the immutable marker is fully published | Both `initialize` and `resume` reject the partial root | Inspect and quarantine or remove the orphan only under separate deletion approval, then authorize a new initialization |
| During marker publication or after an uncatchable termination | A partial marker or O_EXCL lease may remain; it is never overwritten, deleted, or treated as proof | Inspect inode, ownership, ACLs, D1, marker, and process state; quarantine/removal requires separate approval |
| After the marker but before either credential is published | `resume` may create the initial credential pair only while both payer and payment authority tables remain empty | Any persisted payer or payment with missing credentials fails closed; never generate a replacement KEK |
| After the Harbor credential is published but before the Pilot capability | `resume` may complete only the missing capability after exact credential/root/state revalidation | Do not regenerate or rotate either credential as recovery; `initialize` rejects this state |
| After both credentials are published | Exact matching files are reused; any mismatch fails closed | Resolve mismatch manually; no overwrite path exists |
| While the Worker is running | The launcher keeps the lease until the child exits | A stranded lease after SIGKILL requires proof that no process owns the state plus separately approved removal |

These outcomes intentionally preserve evidence instead of self-healing. The
tooling has no automatic deletion, repair, stale-lock takeover, or alternate
root fallback. Retirement or an orphaned initialization does not authorize
deletion.

The paired Pilot interface requires the merchant's `profile_contract.py` to accept
this exact isolated filename and marker set while retaining the legacy check.
Run that preflight against this checked-in JSON before the combined run; never
skip it or point it at a secrets file.

## Future reviewed run sequence

After provisioning is independently reviewed, integrated, and explicitly
approved and run by the operator, the process may be started from its integrated
checkout:

```text
npm run dev:local:x402:isolated:v1
```

The launcher accepts no arguments and validates the exact config, secret file,
credential-bound state root, immutable marker, D1 identity and schema, and
origin. It never initializes or migrates state. Start the merchant and Pilot
only under their separately reviewed runbooks. Stop all three after the local
test. Do not interpret fixture responses as real paid acceptance.
