# AWS event-day runbook — Harbor

This runbook is an operator checklist. It does not authorize Codex to create AWS resources, handle credentials, fund wallets, or submit ledger transactions. Austin owns every live-account and wallet step. Never paste a credential, seed, private key, mnemonic, bearer token, or plaintext KEK into a command, log, issue, status file, or chat.

## Evidence lanes

Keep these labels exact in `status/H-aws.md`:

- **STAND-IN** — loopback `tools/aws-local`, deterministic fixtures, synthetic ledger adapters. This is not AWS or Testnet acceptance.
- **AWS LIVE** — a real AWS request made only after Austin supplies the event environment and explicitly opens the live lane.
- **TESTNET LIVE** — a validated XRPL Testnet transaction with its hash. Mock or planned transactions never use this label.
- **DEFERRED** — a prerequisite or authority is absent. Record the missing item; do not manufacture a pass.

The AWS-4 Testnet acceptance row remains **DEFERRED** until Austin authorizes use of a fresh funded Testnet budget account and the browser/dev owner signer for its `DelegateSet`.

## 1. Preflight and stand-in baseline

Use the AWS-6 worktree. Confirm that the checkout and offline suite are green before starting a service:

```bash
git status --short
npm run typecheck
npm test
```

Start the loopback stand-in in a separate terminal. It binds only `127.0.0.1:8790`:

```bash
npm run aws-local
```

Set only non-secret stand-in switches in the probe terminal:

```bash
export EXEC_NETWORK=testnet
export HARBOR_LOCAL_DEV=true
export AWS_REGION=us-east-1
export AWS_ENDPOINT_OVERRIDE=http://127.0.0.1:8790
export GUARDRAILS_MODE=mock
export KMS_MODE=sign
```

Run every Harbor probe against the stand-in and append only its fixed aggregate evidence:

```bash
node --experimental-transform-types scripts/aws/k1-kms-sign.ts --mode standin --store-file /tmp/harbor-aws6-kms.json --status-file status/H-aws.md
node --experimental-transform-types scripts/aws/k2-latency.ts --mode standin --status-file status/H-aws.md
node --experimental-transform-types scripts/aws/g1-guardrails.ts --status status/H-aws.md
```

Expected evidence:

- K1 reports a locally verified Ed25519 signature from the stand-in. It is not a Testnet `OfferCreate`.
- K2 performs exactly 20 `Sign` calls and reports p50 and p95.
- G1 prints 23 scores: the injection fixtures score high and 20 fixed realistic token names score low.
- No probe prints a key, credential, request body, free-form provider error, or secret-bearing environment value.

If any stand-in probe fails, keep the corresponding live lane closed. Fix and rerun the offline test; do not continue by changing its mode to `off`.

## 2. Austin's AWS setup gate

Austin completes these actions in the AWS console or approved secret-management UI. Codex does not perform them:

1. Create the event AWS account and set budget alerts at $25 and $50.
2. Confirm Bedrock model access for the exact Haiku 5.5 and Sonnet 5.5 model IDs.
3. Create the short-lived `pilot-bedrock` Bedrock API key.
4. Create IAM user `harbor-worker` from `scripts/aws/iam-harbor-worker.json`.
5. Place Harbor IAM values only in the approved external Harbor secret store and the deployed Worker secrets.
6. Place the Bedrock key only in the approved external Pilot environment and Vercel server environment.

Before any live command, the operator confirms without printing values:

```bash
test "${EXEC_NETWORK:-}" = testnet
test "${AWS_REGION:-}" = us-east-1
test -n "${AWS_ACCESS_KEY_ID:-}"
test -n "${AWS_SECRET_ACCESS_KEY:-}"
test -z "${AWS_ENDPOINT_OVERRIDE:-}"
```

Do not source arbitrary files, query EC2/container metadata, inspect browser sessions, or run an AWS credential-discovery command.

## 3. Create the event KEK

This is an **AWS LIVE** write and runs only after Austin opens that lane. The script writes only the ciphertext to the explicit external Harbor environment file and never prints plaintext:

```bash
export EXEC_NETWORK=testnet
export AWS_REGION=us-east-1
unset AWS_ENDPOINT_OVERRIDE
node --experimental-transform-types scripts/aws/create-kek.ts --env-file /absolute/private/pilot/harbor-secrets/harbor.dev.vars
```

Verify only that the external secret-management step succeeded; never display the file or ciphertext. Existing rows wrapped under another KEK must be relinked through an approved migration plan. Do not assume a new KEK can decrypt them.

## 4. Live KMS and Guardrails probes

The checked-in K1/K2/cleanup CLIs intentionally refuse `--mode event` until an explicitly authorized event adapter and inputs are present. Do not bypass that refusal. The event conductor must supply:

- the approved live AWS process environment;
- an explicit alias/key manifest for cleanup, because the IAM policy does not grant `ListAliases` or `ListKeys`;
- for K1, a fresh funded Testnet owner/budget account, the browser/dev owner signer for `DelegateSet`, Harbor account/link identifiers, and the exact 1 tUSD → XRP offer inputs.

The guarded entry points are:

```bash
node --experimental-transform-types scripts/aws/k1-kms-sign.ts --mode event
node --experimental-transform-types scripts/aws/k2-latency.ts --mode event
```

Until the event adapter is explicitly bound, their refusal is **DEFERRED**, not failure and not evidence. Once authorized, K1 must record the validated `tesSUCCESS` hash for exactly one delegated Testnet `OfferCreate`; K2 must record 20 real KMS `Sign` calls with p50/p95. G1 live execution must use `GUARDRAILS_MODE=aws` and retain fail-closed screening. Never set Guardrails to `off` to obtain a demo pass.

If K1 fails after real AWS access is proven, make a deliberate deployment decision to use `KMS_MODE=kek`, redeploy, and label receipts `aws-kms-kek`. There is never a per-transaction fallback from KMS signing to a local key.

## 5. Testnet injection seed plan

From the Pilot AWS-6 worktree, first render and review the plan using public addresses only:

```bash
test -n "${AWS6_PUBLIC_ISSUER_ADDRESS:-}"
test -n "${AWS6_PUBLIC_DEMO_BUDGET_ADDRESS:-}"
pnpm exec tsx scripts/seed-injection.ts --network testnet --issuer "$AWS6_PUBLIC_ISSUER_ADDRESS" --budget "$AWS6_PUBLIC_DEMO_BUDGET_ADDRESS"
```

The plan must be idempotent and limited to:

- an issuer `AccountSet` whose `Domain` contains the injection fixture;
- the budget account's trust line for the demo token;
- an issued-token `Payment` whose memo contains the injection fixture.

The CLI is plan-only and accepts no seed/private-key/mnemonic/file option. Applying the exported plan remains **DEFERRED** until Austin explicitly authorizes funded Testnet issuer and budget dev signers and the event conductor binds them through the approved signing adapter. Record transaction hashes only after validated `tesSUCCESS`; never label plan output as seeded ledger evidence.

## 6. Deploy and rehearse

After the live probes and Testnet seed validate, Austin places the approved server-side values in deployment secrets. Deploy with these intended switches:

```text
EXEC_NETWORK=testnet
GUARDRAILS_MODE=aws
KMS_MODE=sign
BEDROCK_MODE=aws
AWS_REGION=us-east-1
```

If K1 required the documented fallback, use `KMS_MODE=kek`. Keep mainnet execution disabled regardless of any AWS setting.

Run the 60-second rehearsal and preserve the evidence boundary:

1. Pilot shows the AWS Bedrock model selected.
2. Query the injection token; the Guardrails banner identifies blocked untrusted text.
3. Execute the 50 tUSD → XRP demo; the receipt shows screen, model, signer, and a validated Testnet hash.
4. Show the architecture and roadmap slides.

## 7. Cleanup after judging

Test cleanup against an explicit stand-in state file first:

```bash
node --experimental-transform-types scripts/aws/cleanup.ts --mode standin --store-file /tmp/harbor-aws6-kms.json --bedrock-key-name pilot-bedrock --status-file status/H-aws.md
```

Live cleanup is an **AWS LIVE** write. It requires Austin's explicit alias/key manifest and approval. The guarded entry point is:

```bash
node --experimental-transform-types scripts/aws/cleanup.ts --mode event --bedrock-key-name pilot-bedrock
```

For every authorized `alias/harbor/*` key, schedule deletion with the seven-day window; do not delete or alter unrelated keys. The script prints only the Bedrock key name. Austin then revokes `pilot-bedrock` in the approved AWS UI and removes the event IAM credentials and server secrets. Record cleanup as complete only after those actions are independently verified.

## Fallback matrix

| Failure | Allowed response | Evidence label |
| --- | --- | --- |
| Stand-in probe fails | Fix offline implementation; keep live lane closed | DEFERRED |
| Real KMS signing fails | Explicitly switch deployment to `KMS_MODE=kek`; never local fallback | AWS LIVE fallback after verification |
| Guardrails unavailable | Preserve fail-closed redaction; do not switch to `off` for demo | AWS LIVE unavailable/fail-closed |
| Bedrock live probe fails | Set Pilot to `BEDROCK_MODE=mock` and label receipts `bedrock-mock` | STAND-IN/mock |
| Anonymous dataset listing fails | Skip AWS-7; do not infer dataset contents from fixtures | DEFERRED |
| Testnet wallet/funding/signing missing | Stop the Testnet lane and name the missing authority/input | DEFERRED |
