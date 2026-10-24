# AWS event-day runbook — Pilot

This runbook covers Pilot's Bedrock and public-dataset probes and its place in the complete AWS event sequence. It never authorizes credential, wallet, cloud-resource, deployment, or ledger actions. Austin supplies live secrets only through approved server-side secret management; never paste them into source, commands, logs, status files, browser storage, or chat.

## Evidence lanes

- **STAND-IN** — deterministic synthetic Bedrock behavior or a fixed dataset fixture. It is not AWS, a live model, or dataset availability evidence.
- **AWS LIVE** — a real, explicitly authorized Bedrock request.
- **ANONYMOUS PUBLIC READ** — an unsigned read of the public S3 dataset; it creates no resource and uses no credential.
- **TESTNET LIVE** — a validated XRPL Testnet transaction hash produced through Harbor.
- **DEFERRED** — a prerequisite or authority is absent.

Never promote mock evidence to a live label. In particular, a stand-in D1 pass does not unlock AWS-7; only a successful anonymous event listing that exposes transaction type and date can do that.

## 1. Offline and stand-in baseline

From the Pilot repository root:

```bash
git status --short
pnpm typecheck
pnpm test
```

Run B1 once for each deterministic stand-in model and append fixed aggregate evidence:

```bash
pnpm exec tsx scripts/aws/b1-bedrock.ts --mode standin --models standin/haiku-5-5,standin/sonnet-5-5 --status status/P-aws.md
```

Expected output contains one fixed `tool_call=PASS` result per model and a final `B1 PASS ... synthetic=true`. This is a scripted tool-call contract test; `tools/aws-local` does not implement a model runtime.

Run D1 against its deterministic stand-in transport:

```bash
pnpm tsx scripts/aws/d1-dataset.ts --mode standin --status status/P-aws.md
```

The result proves parsing, bounds, safe output, and evidence formatting only. It does not prove that the public bucket currently contains usable transaction data.

## 2. Austin's Bedrock setup gate

Austin completes these steps in the AWS UI:

1. Confirm account budget alerts at $25 and $50.
2. Enable the exact Haiku 5.5 and Sonnet 5.5 model IDs.
3. Create the short-lived `pilot-bedrock` Bedrock API key.
4. Place the key only in the approved external Pilot environment and Vercel server environment as `AWS_BEARER_TOKEN_BEDROCK`.
5. Place the exact comma-separated model IDs in `BEDROCK_MODELS` and set
   `AWS_REGION=us-east-2` for the approved account. Pilot also retains explicit
   legacy `us-east-1` support, but never accepts another Region or falls back
   across Regions.

The operator may confirm presence without printing values:

```bash
case "${AWS_REGION:-}" in us-east-1|us-east-2) ;; *) exit 1 ;; esac
test -n "${AWS_BEARER_TOKEN_BEDROCK:-}"
test -n "${BEDROCK_MODELS:-}"
```

Do not inspect browser sessions, source arbitrary files, enumerate credentials, or log the environment.

## 3. B1 live Bedrock probe

This command makes live model calls and is event-only. Run it only after Austin explicitly opens the live-model lane and confirms the account/cost boundary:

```bash
export BEDROCK_MODE=aws
pnpm exec tsx scripts/aws/b1-bedrock.ts --mode aws --event-live --status status/P-aws.md
```

The probe reads the already supplied `BEDROCK_MODELS` and server-only bearer token from the event process. It must run the scripted tool-calling chat on every listed model and expose no model output, provider error body, token, or credential in evidence.

If B1 fails, switch the demo deliberately to `BEDROCK_MODE=mock`; keep receipts labeled `bedrock-mock`. Do not claim a live Bedrock pass and do not substitute an external live model call.

## 4. D1 anonymous public listing

The dataset is read anonymously from the exact public bucket/prefix. No AWS credential or signing header may be present. This is event-only network access in the current run:

```bash
pnpm tsx scripts/aws/d1-dataset.ts --mode event --confirm-anonymous-read --status status/P-aws.md
```

The probe lists only `s3://aws-public-blockchain/v1.1/sonarx/xrp/` through unsigned HTTPS ListObjectsV2. It must remain read-only and bounded. If the listing does not prove transaction type and date fields, record AWS-7 as **DEFERRED** and do not create the chart. A fixture or cached result never unlocks AWS-7.

## 5. Full deployment and Testnet rehearsal

Harbor's `RUNBOOK-AWS.md` owns KEK creation, K1/K2/G1, the injection seed plan, KMS cleanup, and the exact fresh-wallet Testnet authority gate. After those live gates pass, Austin deploys Pilot with:

```text
BEDROCK_MODE=aws
AWS_REGION=us-east-2
BEDROCK_MODELS=<exact event model IDs>
BEDROCK_DAILY_TURN_CAP=50
```

The selected Region must contain every explicitly allowlisted Bedrock model;
Pilot never retries in the other Region. The Bedrock bearer token remains
server-only. Logged-out and demo visitors remain on the configured free
OpenRouter behavior; only eligible signed-in sessions may use Bedrock.

Rehearse:

1. Select an AWS Bedrock model as an eligible signed-in user.
2. Ask about the Testnet injection token and verify the Guardrails banner.
3. Run the 50 tUSD → XRP demo through Harbor and preserve the validated Testnet hash.
4. Confirm the intent card's model, screen, and signer chips match the actual lane (`bedrock`, `aws-bedrock-guardrails`, and `aws-kms` or the documented `aws-kms-kek` fallback).

If any transaction lacks validated ledger evidence, label the rehearsal **DEFERRED**. Never use a fixture or mock receipt as Testnet acceptance.

## 6. Cleanup

After judging:

1. Follow Harbor's cleanup procedure with Austin's explicit alias/key manifest; the current IAM policy intentionally cannot list arbitrary keys.
2. Austin revokes `pilot-bedrock` by name in the approved AWS UI.
3. Austin removes the Bedrock bearer token and event model list from deployed and external environments.
4. Verify that Pilot no longer accepts `BEDROCK_MODE=aws` without the server-side key.
5. Record cleanup only after independent verification; never print the removed value.

## Fallback matrix

| Failure | Allowed response | Evidence label |
| --- | --- | --- |
| B1 stand-in fails | Fix offline behavior; keep live-model lane closed | DEFERRED |
| B1 live fails | Use `BEDROCK_MODE=mock`; label `bedrock-mock` | STAND-IN/mock |
| D1 anonymous listing fails or lacks type/date | Skip AWS-7 | DEFERRED |
| Harbor K1 live fails | Use the deliberate `KMS_MODE=kek` deployment fallback | AWS LIVE fallback after verification |
| Guardrails live unavailable | Preserve Harbor fail-closed redaction | AWS LIVE unavailable/fail-closed |
| Testnet authority, funding, or validated hash missing | Stop the Testnet lane | DEFERRED |
