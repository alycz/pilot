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

- **Vercel:** set the project root to `docs-site`, build command `npm run build`, output directory `dist/public`.
- **Netlify / any static host:** publish `dist/public`.

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
