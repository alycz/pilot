# QuickNode event-day runbook

This runbook keeps the practice build on local stand-ins and makes every live
QuickNode claim an explicit event-day action. Never put a QuickNode endpoint,
API key, security token, signed blob, seed, or private key in this repository,
a command argument, a log, or a status note. Mainnet remains disabled.

## Current stand-in rehearsal

Run from the unified repository root using Harbor's isolated source paths:

```sh
npx vitest run services/harbor/scripts/quicknode

node --experimental-transform-types services/harbor/scripts/quicknode/q1-coverage.ts \
  --mode mock \
  --fixture services/harbor/scripts/quicknode/fixtures/q1-coverage.mock.json \
  --status status/H-qn.md

node --experimental-transform-types services/harbor/scripts/quicknode/q2-submit.ts \
  --mode mock \
  --fixture services/harbor/scripts/quicknode/fixtures/q2-submit.mock.json \
  --status status/H-qn.md

node --experimental-transform-types services/harbor/scripts/quicknode/q3-webhook.ts \
  --mode mock \
  --payload services/harbor/scripts/quicknode/fixtures/q3-wallet.mock.json \
  --standin-payload services/harbor/scripts/quicknode/fixtures/q3-wallet.mock.json \
  --execution services/harbor/scripts/quicknode/fixtures/q3-execution.mock.json \
  --output /tmp/q3-wallet.sanitized.json \
  --status status/H-qn.md

node --experimental-transform-types services/harbor/scripts/quicknode/q4-watchdog.ts \
  --mode mock \
  --proof services/harbor/scripts/quicknode/fixtures/q4-watchdog.mock.json \
  --status status/H-qn.md

node --experimental-transform-types services/harbor/scripts/quicknode/q5-facts.ts \
  --source stand-in \
  --network-slug xrp-testnet \
  --dataset Ledger \
  --webhook-delete-path '/webhooks/rest/v1/webhooks/{id}' \
  --output services/harbor/quicknode/facts.json \
  --status status/H-qn.md
```

The QN-6 provisioning tests exercise `up`, idempotent `up`, `status`, and
complete `down` with a deterministic injected management stand-in. The checked
in `tools/qn-local` implements KV and `test_filter`, but not QuickNode's webhook
or Streams management CRUD. Therefore this rehearsal is mock evidence only and
must not be described as a provisioned QuickNode account.

Run from the unified repository root:

```sh
pnpm exec tsx scripts/quicknode/demo-fixtures.ts
```

The Pilot probe validates the logged-out QuickNode fixtures and bounded freeze
projection without opening a browser or contacting Harbor. It does not replace
browser acceptance or live provider evidence.

## Event-day prerequisites owned by Austin

1. Create the hackathon QuickNode account and one XRPL **testnet** endpoint.
2. Create one QuickNode API key and two fresh webhook/Streams security tokens.
3. Put the endpoint URL (including its token), API key, security tokens, and
   existing Harbor API key in the external secrets files only.
4. In the QuickNode dashboard, verify the Webhooks/Streams network slug,
   Streams Ledger dataset value, webhook delete-by-ID path, and actual wallet
   delivery shape. Do not infer these values from the stand-in.
5. Choose the three recorded testnet ledger indexes used by `test_filter`: one
   Harbor execution, one rogue delegate transaction, and one ledger without a
   watched account.

The scripts expect the following non-secret switch values in the event shell:

```sh
export EXEC_NETWORK=testnet
export QN_RUN_TAG=event
export QN_MODE=live
export QN_API_BASE=https://api.quicknode.com
export QN_NETWORK_SLUG=xrp-testnet
export QN_STREAM_DATASET=Ledger
export QN_STREAM_REGION=usa
export QN_WEBHOOK_DELETE_PATH='/webhooks/rest/v1/webhooks/{id}'
export HARBOR_PUBLIC_URL=https://YOUR-HARBOR-HOST
```

The external secret loader must separately provide `QN_XRPL_TESTNET_HTTP`,
`QN_API_KEY`, `QN_WEBHOOK_SECURITY_TOKEN`, `QN_STREAM_SECURITY_TOKEN`, and
`HARBOR_API_KEY`. Do not echo them or pass them on the command line.

## Ordered event-day procedure

### 1. Record facts and endpoint coverage

After verifying the dashboard values, record their provenance:

```sh
node --experimental-transform-types services/harbor/scripts/quicknode/q5-facts.ts \
  --source quicknode-event \
  --network-slug "$QN_NETWORK_SLUG" \
  --dataset "$QN_STREAM_DATASET" \
  --webhook-delete-path "$QN_WEBHOOK_DELETE_PATH" \
  --output services/harbor/quicknode/facts.json \
  --status status/H-qn.md

node --experimental-transform-types services/harbor/scripts/quicknode/q1-coverage.ts \
  --mode live \
  --output services/harbor/src/quicknode/coverage.testnet.json \
  --status status/H-qn.md
```

The coverage probe reads the token-bearing endpoint only from
`QN_XRPL_TESTNET_HTTP`; never supply it with `--url`. Review and commit
`services/harbor/quicknode/facts.json` and `services/harbor/src/quicknode/coverage.testnet.json`, then deploy
Harbor with `QN_MODE=live`. Confirm mainnet is still disabled.

### 2. Prove routed submission

Prepare a temporary owner-signed **testnet Payment** request through the
approved wallet flow. The JSON must contain `operation: "tx.submit"`,
`network: "testnet"`, `transaction_type: "Payment"`, and the `tx.submit`
arguments. It must contain no seed or private key. Keep it outside git with
owner-only permissions, then run:

```sh
node --experimental-transform-types services/harbor/scripts/quicknode/q2-submit.ts \
  --mode live \
  --request "$QN_Q2_REQUEST_PATH" \
  --harbor-url "$HARBOR_PUBLIC_URL/" \
  --status status/H-qn.md
```

Pass only if the validated response says `route=quicknode` and records at
least one QuickNode RPC call. A fallback or `quicknode-mock` result is not a
live pass.

### 3. Provision KV, webhook, and watchdog stream

Set the three reviewed ledger indexes without placing transaction material in
the shell:

```sh
export QN_TEST_LEDGER_HARBOR=REVIEWED_LEDGER_INDEX
export QN_TEST_LEDGER_ROGUE=REVIEWED_LEDGER_INDEX
export QN_TEST_LEDGER_NONE=REVIEWED_LEDGER_INDEX

node --experimental-transform-types services/harbor/scripts/quicknode/provision.ts up --run event
node --experimental-transform-types services/harbor/scripts/quicknode/provision.ts status --run event
```

`up` first runs `quicknode.kv.reconcile`, creates or reuses the named
`xrplWalletFilter` webhook with `compression:"none"`, runs the materialized
watchdog filter against all three ledgers, then creates or reuses the Stream
with `end_range:-1` and no backfill. IDs are written only to
`/absolute/private/pilot/harbor-state/qn-state.event.json` with owner-only permissions.

### 4. Prove the webhook

The current integration base verifies webhook HMACs inside Harbor but does not
export an authenticated raw-capture artifact that the probe can independently
bind to the matching execution. Consequently `q3-webhook.ts --mode live`
fails closed. Do not substitute a caller-generated digest receipt or relabel a
saved payload as live evidence. Once the authenticated capture seam exists,
update this probe and run it with the temporary raw delivery and matching
Harbor execution; continue to commit only the sanitized fixed-field fixture.

The following command is the explicit stop check on this base:

```sh
node --experimental-transform-types services/harbor/scripts/quicknode/q3-webhook.ts \
  --mode live \
  --payload "$QN_Q3_PAYLOAD_PATH" \
  --standin-payload services/harbor/scripts/quicknode/fixtures/q3-wallet.mock.json \
  --execution "$QN_Q3_EXECUTION_PATH" \
  --output services/harbor/scripts/quicknode/fixtures/q3-wallet.sanitized.json \
  --status status/H-qn.md
```

It must fail with the authenticated-capture dependency; it is not a live pass.

### 5. Prove the watchdog

The approved QN-4 `services/harbor/scripts/quicknode/rogue-delegate.ts` testnet runner is absent
from this integration base. Consequently `q4-watchdog.ts --mode live` fails
closed before it reads any caller-supplied proof. Do not substitute a digest
receipt. The following command is the explicit stop check:

```sh
node --experimental-transform-types services/harbor/scripts/quicknode/q4-watchdog.ts \
  --mode live \
  --proof "$QN_Q4_PROOF_PATH" \
  --status status/H-qn.md
```

It must fail with the missing-runner dependency; it is not a live pass. Once
the runner lands, update this probe to invoke or authenticate its real output
before running the event check. A Harbor freeze only stops Harbor from using
the key. The owner must use the normal on-ledger revoke flow to remove the
delegate everywhere.

### 6. Observability and fallback

In the QuickNode dashboard, verify Endpoint, Webhooks, Streams, and KV show the
expected Transactions, Errors, and Usage. If any live step fails, set
`QN_MODE=mock`, redeploy Harbor, and verify Pilot labels every QuickNode chip
`(mock)`. Do not hide fallback routing or claim provider acceptance.

## Teardown

After judging:

```sh
node --experimental-transform-types services/harbor/scripts/quicknode/provision.ts status --run event
node --experimental-transform-types services/harbor/scripts/quicknode/provision.ts down --run event
node --experimental-transform-types services/harbor/scripts/quicknode/provision.ts status --run event
```

`down` pauses and deletes the tagged stream, deletes the tagged webhook through
the event-verified delete path, deletes all five
`harbor_testnet_event_*` KV lists, and fails unless final status reports zero
tagged resources. It does not delete unrelated resources.
