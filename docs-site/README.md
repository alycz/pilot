# Pilot docs

Documentation site for Pilot (MCP & API, trading harness, integrations), built with [Vocs](https://vocs.dev) v2.

This package is standalone (npm, not part of the pnpm workspace) so it does not touch the app lockfile.

## Develop

```bash
cd docs-site
npm install
npm run dev        # http://localhost:5173
```

## Build

```bash
npm run build      # static output in dist/public (renderStrategy: full-static)
npm run preview
```

## Deploy

The site is built with `basePath: '/docs'` so it can live on the Pilot domain.

1. **Deploy the docs** as their own Vercel project with root directory `docs-site`. `vercel.json` sets the build and output and maps `/docs/*` to the files, so the deployment also works on its own URL.
2. **Mount them in Pilot:** set `PILOT_DOCS_ORIGIN=https://<docs-deployment>` on the Pilot project and redeploy. Pilot then proxies `/docs/*` to it, and the **Docs** link in the site header (next to Integrations) opens them. Without it, `/docs` shows a fallback page.

Locally: `npm run dev` here, then start Pilot with `PILOT_DOCS_ORIGIN=http://127.0.0.1:5173`.

On the Pilot domain, bare `/docs` redirects to `/docs/introduction/what-is-pilot`. The docs router needs `/docs/` with a trailing slash, which Next normalizes away, so the docs landing page is only shown on the docs deployment's own URL.

## Structure

```text
vocs.config.ts          sidebar, top nav, theme, banner
public/icon.svg         favicon (same mark as the app)
src/pages/
  index.mdx             landing
  introduction/         what Pilot is, how it works, security model
  quickstart/           app, MCP clients, REST, local
  mcp/                  MCP tools, REST, auth, envelope, transactions, policy, venues
  harness/              agent loop, intents, lifecycle, onboarding, memory, strategies, backtesting, evals
  integrations/         one page per integration
  reference/            all operations, environment, status, glossary
```

## Keeping it accurate

Facts here are taken from the code. When you change any of these, update the matching page:

| Code | Page |
| --- | --- |
| `services/harbor/src/ops/*.ts` (operation added/removed) | `reference/operations.mdx`, `mcp/overview.mdx` counts |
| `DEFAULT_POLICY`, `src/exec/policy.ts`, `src/exec/delegation.ts` | `mcp/policy.mdx` |
| `src/executor/quickjs.ts`, `src/guard/*` (sandbox limits) | `mcp/tools.mdx` |
| `packages/intents`, `packages/agent/src/tools.ts`, `card-state.ts` | `harness/*` |
| integration status in `apps/web/components/integrations/content/*.ts` | `integrations/*`, `reference/status.mdx` |

Statuses are deliberately conservative: say *built*, *mock-first* or *stand-in* until a live acceptance lane has run.
