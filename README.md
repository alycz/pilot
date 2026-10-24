# pilot

Pilot is a Next.js application for interacting with the XRP Ledger through Harbor. A user chats with the agent, reviews a typed intent, and either delegates an allowed action to Harbor or signs an approval in their own wallet. Pilot never holds an owner key. Validated results are written to an Obsidian-compatible Markdown vault.

## Safety model

- Execution defaults to XRPL Testnet. Mainnet execution is prohibited.
- The browser never receives `HARBOR_API_KEY`, `DEMO_OPENROUTER_API_KEY`, a user OpenRouter key, or server-side wallet credentials.
- Harbor delegation covers only explicitly granted transaction types and policy-approved actions. Owner approvals are sign-only in the wallet; Harbor submits the signed blob.
- Pilot does not provide the model with a signing tool and does not execute perpetual futures.
- Before the live integration gate, `HARBOR_MOCK=1` keeps all Harbor operations fixture-backed.

## Workspace

```text
apps/web                 Next.js 15 App Router application
packages/contracts       Hash-checked copy of Harbor contracts
packages/intents         Typed intents and intent-to-builder mapping
packages/agent           Agent prompt, tools, and card state machine
packages/harbor-client   Typed REST and MCP clients, plus mock fixtures
packages/vault           Obsidian note writers, search, and backends
packages/wallet          Owner-wallet signing adapters
```

Node.js 24 and pnpm are required.

## Local setup

1. Install dependencies.

   ```bash
   pnpm install
   ```

2. Link the externally managed local environment file. Do not copy or commit it.

   ```bash
   ln -sf "${PILOT_PRIVATE_SECRETS_ROOT:?set PILOT_PRIVATE_SECRETS_ROOT}/pilot.env.local" apps/web/.env.local
   ```

3. Keep `HARBOR_MOCK=1` until the live integration gate, then start the app.

   ```bash
   pnpm dev
   ```

The development server listens on `http://localhost:3000`. The checked-in [.env.example](.env.example) documents every Pilot environment variable without containing credentials.

## Checks

```bash
pnpm typecheck
pnpm test
```

Unit tests are offline and must not consume OpenRouter quota or access live XRPL endpoints. Browser acceptance requires a separately configured test environment.

## Credits

Pilot preserves the following required third-party notices and public references.

### Dependencies

| Project | Use | License / source |
| --- | --- | --- |
| [Next.js](https://nextjs.org/) and [React](https://react.dev/) | App Router web application | MIT |
| [Tailwind CSS](https://tailwindcss.com/) and [shadcn/ui](https://ui.shadcn.com/) | Styling and accessible UI primitives | MIT |
| [class-variance-authority](https://cva.style/), [clsx](https://github.com/lukeed/clsx), [tailwind-merge](https://github.com/dcastil/tailwind-merge), and [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | shadcn/ui composition and utility-class handling | Apache-2.0 / MIT; see projects |
| [Lucide](https://lucide.dev/) | Interface icons | ISC |
| [Motion](https://motion.dev/) (Framer Motion) | Interface animation | MIT |
| [Vercel AI SDK](https://ai-sdk.dev/) and [OpenRouter AI SDK Provider](https://github.com/OpenRouterTeam/ai-sdk-provider) | Agent streaming, tool calls, and model access | Apache-2.0 / MIT; see projects |
| [Zod](https://zod.dev/) | Runtime schemas and TypeScript validation | MIT |
| [xrpl.js](https://js.xrpl.org/) | XRP Ledger JSON-RPC and WebSocket client | ISC |
| [xrpl-connect](https://github.com/XRPL-Commons/xrpl-connect) | Owner wallet connection and sign-only approvals | See project |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Streamable HTTP MCP client | MIT |
| [gray-matter](https://github.com/jonschlinkert/gray-matter) | Markdown frontmatter | MIT |
| [MiniSearch](https://github.com/lucaong/minisearch) | Local vault and catalog search | MIT |
| [simple-git](https://github.com/steveukx/git-js) | Filesystem-vault Git commits | MIT |
| [Octokit](https://github.com/octokit/octokit.js) | GitHub-backed vault commits | MIT |
| [Vitest](https://vitest.dev/) | Unit tests | MIT |
| [Playwright](https://playwright.dev/) | End-to-end tests | Apache-2.0 |
| [tsx](https://tsx.is/) | TypeScript script runner | MIT |
| [TypeScript](https://www.typescriptlang.org/), [Node.js](https://nodejs.org/), and [pnpm](https://pnpm.io/) | Language, runtime, and workspace package manager | Apache-2.0 / MIT; see projects |
| [x402-xrpl](https://pypi.org/project/x402-xrpl/) and [FastAPI](https://fastapi.tiangolo.com/) | Testnet x402 merchant function | See projects / MIT |

### Public protocols, services, and references

| Reference | How Pilot/Harbor uses it |
| --- | --- |
| [XRP Ledger documentation](https://xrpl.org/docs/) and [XRPL Docs MCP](https://xrpl.org/resources/dev-tools/ai-tools) | Canonical protocol, transaction, amendment, and API documentation |
| [XRPL Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation), [permission values](https://xrpl.org/docs/references/protocol/data-types/permission-values), and [delegate samples](https://github.com/XRPLF/xrpl-dev-portal/tree/master/_code-samples/delegate-permissions/) | Delegated execution model and transaction construction |
| [XRPL trading skill](https://xrpl.org/docs/agents/xrpl-trading-skill) and [XRPL developer skills](https://github.com/XRPLF/xrpl-dev-portal/tree/master/.claude/skills/xrpl-skills/) | Transaction patterns and preflight guardrails |
| [Ripple lending reference app](https://github.com/ripple/xrpl-reference-app-lending-sav) | Public reference for XLS-65/66 Devnet transaction shapes |
| [xrpl.to API](https://api.xrpl.to/v1), [XRPSCAN API](https://docs.xrpscan.com/api-documentation/amm/pools), and [Bithomp API](https://docs.bithomp.com/) | Token and AMM indexing, with documented fallbacks |
| [xrpldashboard MCP](https://mcp.xrpldashboard.com/mcp) | Optional amendments and AMM TVL data |
| [RLUSD developer documentation](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl) | Stablecoin issuer and trust-line reference |
| [x402 on XRPL](https://xrpl.org/docs/agents/agentic-payments-x402) | Testnet premium-data payment flow |
| [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) and [Dynamic Workers](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/) | Public architectural references for Harbor's sandboxed execution |
| [OpenRouter](https://openrouter.ai/docs/) | Bring-your-own-model OAuth and capped demo-model access |
| [Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) | Read-only XRP perpetual-market metadata; never execution |
| [Obsidian](https://help.obsidian.md/) and [Vercel](https://vercel.com/docs) | Markdown-vault interoperability and application hosting |

No source code is imported from Stellar projects or unrelated wallet/agent implementations.
