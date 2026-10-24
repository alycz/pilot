# Execution Service

Harbor is a Cloudflare Worker that exposes XRP Ledger venue operations through
two MCP tools (`search` and `execute`) and a REST mirror at
`POST /api/ops/{op}`. It scopes every request and database query to the API-key
name, runs generated scripts without outbound network access, and never holds
owner keys.

## Requirements

- Node.js 24
- npm
- Wrangler authenticated to the project Cloudflare account
- owner-controlled external runtime files identified by `HARBOR_RUN_ENV_PATH`, `HARBOR_PRIVATE_SECRETS_ROOT`, `PILOT_PRIVATE_SECRETS_ROOT`, and `HARBOR_PRIVATE_EVIDENCE_ROOT`

Resource names come only from the owner-provided external run configuration. Execution is limited to XRPL
testnet or devnet; mainnet execution is always disabled.

## Local setup

```bash
ln -sf "${HARBOR_PRIVATE_SECRETS_ROOT:?set HARBOR_PRIVATE_SECRETS_ROOT}/harbor.dev.vars" .dev.vars
npm ci
npm run typecheck
npm test
npx wrangler d1 migrations apply pilot-harbor-disabled --local
npm run dev -- --port 8787
```

The local Worker serves:

- `GET /health`
- `/mcp` using MCP Streamable HTTP
- `POST /api/ops/{op}` with the same registry and envelopes used by `execute`

Remote requests use `Authorization: Bearer <name>:<token>`. Wrangler loopback
development requests bypass the header and use principal `local-dev`.

## Provisioning

Run this only for the scoped resources named in the run kit:

```bash
./scripts/bootstrap.sh
```

The idempotent script creates or reuses the `pilot-harbor-disabled` D1 database,
updates the `DB` and `LOADER` bindings, writes Harbor secrets outside git,
applies local and remote migrations, checks required XRPL amendments, funds
three generated faucet wallets on each test network, and probes Dynamic
Workers. If the Loader probe fails, it verifies QuickJS and records that
fallback in an owner-controlled evidence log outside this repository.

`scripts/teardown.sh` is deliberately separate and destructive. It is never
part of setup or tests.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Regenerate the catalog and run Wrangler locally |
| `npm run typecheck` | Type-check without emitting files |
| `npm test` | Regenerate the catalog and run offline unit tests |
| `npm run test:smoke` | Check a running Worker at `HARBOR_SMOKE_URL` |
| `npm run deploy` | Regenerate the catalog and deploy the scoped Worker |

## Credits

The execution service uses these third-party
packages and public references:

- [`xrpl`](https://github.com/XRPLF/xrpl.js) — XRP Ledger client and wallet utilities
- [`zod`](https://zod.dev/) — runtime schemas and inferred contract types
- [`minisearch`](https://lucaong.github.io/minisearch/) — operation catalog search
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server and Streamable HTTP transport
- [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) — fallback script sandbox
- [`yaml`](https://eemeli.org/yaml/) — venue catalog parsing
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) — Worker and D1 development/deployment
- [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/) — Cloudflare Worker test integration available for later live suites
- [`vitest`](https://vitest.dev/) — offline unit tests
- [`typescript`](https://www.typescriptlang.org/) and [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) — type checking
- [Cloudflare Dynamic Workers](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/) — Loader API and no-egress sandbox pattern
- [XRPL Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation) and [XRPL API docs](https://xrpl.org/docs/references/http-websocket-apis/) — protocol facts and amendment checks
