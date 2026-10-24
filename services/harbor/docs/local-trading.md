# Local trading profile

The local trading profile is a separate, testnet-only Harbor process for the
reviewed local trading flow. It listens only on `http://127.0.0.1:8791`, uses the
isolated `.wrangler/harbor-local-trading` D1 state, requires one named bearer
credential, disables cron and x402, and exposes only `tx.swap`, `tx.execute`,
`tx.submit`, and `tx.status`.

After the separate action-time approval for local credential creation, create
`/absolute/private/pilot/harbor-secrets/harbor-local-trading.env.local`
with the fixed local-only provisioner while every Harbor profile is stopped:

```bash
npm run provision:local:trading -- --principal '<NAMED_LOCAL_PRINCIPAL>'
```

The principal must not be `local-dev`. The provisioner accepts no token or KEK
argument, emits neither secret, and creates exactly one fresh bearer credential
and one fresh 32-byte KEK. It publishes the two-key file as current-user-owned
mode `0600` through an fsynced no-clobber staging inode. The immediate secrets
directory must already be canonical, current-user-owned mode `0700`; every
ancestor must be canonical, owned by the current user or root, and not
group/world writable. An existing target, symlink, unsafe path, or orphaned
staging entry fails closed and is never overwritten, repaired, or deleted. An
exclusive owner-only provisioning lock serializes concurrent attempts; a lock
left by a crashed process also fails closed and requires explicit operator
recovery rather than automatic deletion.
This provisioner is intentionally macOS-only and requires the macOS system Ruby
and Fiddle runtime. Its checked-in narrow ACL inspector runs under the root-owned
`/usr/bin/ruby` and uses `acl_get_fd_np` directly, without reading secret
contents or creating an executable. This distinguishes an empty extended ACL
from a retrieval failure; interpreter, open, retrieval, conversion, execution,
or output errors fail closed.
The secrets directory, provisioning lock, and newly created staging inode must
have no ACL entries; ancestors may contain only deny entries. Parent ACLs and
the new staging inode are checked before the API token or KEK is generated or
written, then the parent chain is rechecked before publication. The provisioner
never adds, removes, or changes an ACL or other security setting.
The credential and KEK belong only to this trading state. The launcher itself
does not generate credentials, use a faucet, or read production Wrangler
configuration. It refuses command-line overrides and rejects any existing
state directory not at mode `0700`, file not at mode `0600`, different owner,
symlink, hard link, or special file; it never repairs, deletes, or changes
existing state permissions. Canonical `0755` parent directories are accepted,
but group/world-writable ancestors are not.

Run `npm run dev:local:trading` only after the separate
[local trading onboarding protocol](local-trading-onboarding.md) has persisted
and verified the exact principal-scoped Testnet state, its authenticated
`onboarding.readiness` attestation returned `ready: true`, and the onboarding
process has stopped. `GET /health` is process health only and never satisfies
that handoff gate. Calls must
use `Authorization: Bearer <principal>:<local-trading-api-key>`. Request
`execution_mode: "fill_or_kill"` through `tx.swap` when required, and pass the
stored `build_id` to `tx.execute`; `require_owner_approval: true` retains its
existing literal-only contract. Here `tx.submit` accepts only an
approval-backed continuation of a trading-origin build. The no-approval,
owner-signed `DelegateSet` relay remains isolated to the exact reviewed
onboarding profile, and its status binding cannot cross the
onboarding-to-trading handoff. Run this profile separately from other local
profiles because they share the fixed port.

Cron is intentionally disabled, so this profile does not run Harbor's foreign
delegated-transaction watcher or automatic suspension path. Initialization and
link verification remain isolated in the onboarding profile; do not widen the
six-operation runtime allowlist (`tx.swap`, `tx.approvalPreflight`,
`tx.approvalReconcile`, `tx.execute`, `tx.submit`, and `tx.status`) to bootstrap
an empty database.

## XRPL transport limitation

The generic XRPL WebSocket transport does not currently apply the 4 MiB
response-body cap enforced by the JSON-RPC HTTP transport. The reviewed local
trading profile cannot reach that unbounded transport: its configuration
validator accepts only the exact Wrangler variable set, its secret file accepts
only `HARBOR_API_KEYS` and `HARBOR_KEK`, and its sparse child environment drops
caller-supplied XRPL endpoint variables. Its six-operation allowlist excludes
WebSocket-only `path_find`, `subscribe`, and `unsubscribe`.

`tx.swap` obtains its exact-output quote with the one-shot, validated-ledger
`ripple_path_find` method over bounded JSON-RPC HTTP; it does not invoke
WebSocket-only `path_find`. This is a profile-specific safety argument, not a
generic WebSocket response-size guarantee. Do not add XRPL endpoint overrides,
WebSocket-only operations, or explicit WebSocket transport selection to this
profile until the generic WebSocket transport enforces an equivalent bound.

## State preparation boundary

Leave `.wrangler/harbor-local` and `.wrangler/harbor-local-x402` unchanged.
After separate action-time approval for the new credential and Testnet wallet
state, prepare only the fresh `.wrangler/harbor-local-trading` tree:

1. With the approved operator present, run the fixed provisioner above once.
   Keep the secrets directory at `0700`; the provisioner creates the file at
   `0600` and never returns or prints either secret.
2. With umask `077`, apply `migrations/` locally using
   `wrangler.local-trading.jsonc`, `--local`, `--persist-to
   .wrangler/harbor-local-trading`, and `config/local-empty.env`. Do not start
   the Worker yet.
3. Use a separately reviewed offline importer/provisioner to install only the
   named principal's validated Testnet link, wrapped delegate, and intended
   policy. No such importer is included in this increment.
4. Verify the trading root and every nested directory are current-user-owned
   `0700`, and every regular file is current-user-owned `0600` with one link.
   If any existing entry is unsafe, stop; do not chmod, delete, or reuse it.
5. Start `npm run dev:local:trading` only after those checks and run it serially
   with the other local profiles because all use port `8791`.

This sequence creates no cloud resource and uses no production or x402 state.
