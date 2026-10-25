# Free/QuickJS Workers.dev rollout procedure

This runbook requires four separately approved operator inputs:

- Worker: `<approved-worker-name>`
- D1 database: `<approved-d1-name>`
- account subdomain: `<approved-account-subdomain>`
- public origin: `https://<approved-worker-name>.<approved-account-subdomain>.workers.dev`
- network: XRPL Testnet
- migration ceiling: every frozen migration in `migrations-free-quickjs/`,
  ending at `0010_ap4m_channel_purchase.sql`

It does not authorize a deployment. Run the remote steps only from the intended
Cloudflare account after an operator separately approves resource creation and
deployment. Do not modify or reuse any pre-existing Worker or D1 database.

## Safety contract

The generated profile has no Worker Loader, cron, custom-domain route, source
maps, or observability. It fixes `workers_dev=true` and keeps mainnet, REST
execution, autonomous execution, MCP execute, QuickNode, Mastercard/AP4M,
AP4M EVM, KMS, AWS Guardrails, and shared model quota disabled. `HARBOR_MOCK=1`
and `LIVE=0` make the remaining non-executing profile explicit. Enabling any of
those capabilities is a separate reviewed change, not an operator override.

## 1. Offline verification

From `services/harbor` in the reviewed commit:

```sh
npm ci
npm run migrations:free:check
npm test -- --run test/deployment-config.test.ts test/free-profile-rest-gate.test.ts
npm run typecheck
npm run cf-typegen:free:check
npm run deploy:free:dry-run
```

The checked-in config remains undeployable because the D1 UUID is all zeroes.
The dry run only verifies the no-Loader bundle and must not be replaced with a
remote deploy during development review.

## 2. Account and target preflight

After separate operator authorization, authenticate Wrangler to the intended
account and verify its displayed account identity. Confirm the exact Worker and
D1 names below are absent before creation. If either exists unexpectedly, stop;
do not reuse, delete, or mutate it.

```sh
npx wrangler whoami
npx wrangler deployments list --name <approved-worker-name>
npx wrangler d1 list
```

The expected pre-creation state is no exact approved Worker name and no exact
approved D1 name. Other resources are out of scope.

## 3. Create only the approved D1 database

This is the first mutating step and requires explicit resource-creation
approval:

```sh
npx wrangler d1 create <approved-d1-name>
```

Record the returned UUID in an owner-private operator location; it is not a
repository input. Then generate a config outside the checkout:

```sh
PILOT_OPERATOR_DIR=/absolute/owner-private/path
mkdir -p "$PILOT_OPERATOR_DIR"
npm run config:free:generate -- \
  --profile free-quickjs \
  --worker-name <approved-worker-name> \
  --database-name <approved-d1-name> \
  --database-id <returned-d1-uuid> \
  --origin https://<approved-worker-name>.<approved-account-subdomain>.workers.dev \
  --output "$PILOT_OPERATOR_DIR/wrangler.free-quickjs.operator.jsonc"
```

Review the generated file. It must have `workers_dev: true`, no `routes`, no
`worker_loaders`, no cron entries, an absolute `migrations_dir` pointing to the
reviewed checkout's `migrations-free-quickjs` directory, an absolute `main`
pointing to the reviewed `src/server.ts`, and every safety variable from the
checked-in template. Regenerate the operator config rather than editing those
paths if the checkout moves.

## 4. Backup and apply only migrations through 0010

Set the task-specific path for the following commands:

```sh
PILOT_HARBOR_CONFIG=/absolute/owner-private/path/wrangler.free-quickjs.operator.jsonc
npx wrangler d1 migrations list DB --remote --config "$PILOT_HARBOR_CONFIG"
npx wrangler d1 export DB --remote --config "$PILOT_HARBOR_CONFIG" \
  --output /absolute/owner-private/path/approved-harbor-before-0010.sql
npx wrangler d1 migrations apply DB --remote --config "$PILOT_HARBOR_CONFIG"
npx wrangler d1 migrations list DB --remote --config "$PILOT_HARBOR_CONFIG"
```

The config's frozen migration directory contains twelve files because the
canonical history has two reviewed `0002` files and two reviewed `0008` files.
The final applied filename must be `0010_ap4m_channel_purchase.sql`; `0011` and
later must not appear. Stop on any different inventory, partial application, or
unknown outcome. Check remote state before retrying a command.

## 5. Secret, bundle, and deploy gates

Do not put credentials in the config or shell history. Install the scoped
Harbor bearer value only through Wrangler's interactive secret input after
separate secret-configuration approval:

```sh
npx wrangler secret put HARBOR_API_KEYS --config "$PILOT_HARBOR_CONFIG"
```

Then produce and inspect a fresh local bundle:

```sh
npx wrangler deploy --dry-run --config "$PILOT_HARBOR_CONFIG" \
  --outdir /absolute/owner-private/path/approved-harbor-dry-run
```

Only after that bundle, configuration, migration history, and account target
are reviewed may an operator run the separately authorized deploy:

```sh
npx wrangler deploy --config "$PILOT_HARBOR_CONFIG"
```

The returned URL must equal the approved origin. Smoke only `GET /health` and
an unauthenticated denial; do not exercise execution, partner, model, signing,
or transaction paths as part of deployment readiness.

## Rollback and recovery

- Record the pre-deploy Worker version from `wrangler deployments list`.
- If a later Worker version fails smoke checks, use `wrangler rollback` with
  that exact known-good version after separate rollback approval. Do not delete
  the Worker or change another Worker.
- D1 migrations are forward-only. Do not attempt destructive down-migrations.
  Preserve the pre-migration export. If schema recovery is required, stop and
  restore into a separately approved replacement D1 database, rebind a reviewed
  config, and redeploy a reviewed Worker version.
- If the first-ever Worker deployment has no prior version, stop serving it
  through an approved Cloudflare disable/rollback action. Do not improvise a
  delete, rename, or reuse of an existing resource.
- Keep all execution and integration flags off throughout rollback. A rollback
  is not permission to enable a provider or submit a transaction.
