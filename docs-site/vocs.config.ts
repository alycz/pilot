import { defineConfig } from 'vocs/config'

const built = { text: 'Built', variant: 'info' } as const
const mock = { text: 'Mock-first', variant: 'warning' } as const
const off = { text: 'Default off', variant: 'note' } as const

export default defineConfig({
  title: 'Pilot',
  titleTemplate: '%s · Pilot Docs',
  description:
    'Pilot is the agentic DeFi terminal for the XRP Ledger: one MCP server and REST API for every XRPL venue, plus a policy-bound trading harness that never holds your keys.',
  // iconUrl is not prefixed with basePath automatically.
  iconUrl: '/docs/icon.svg',
  head: {
    script: [{ src: '/docs/base-path.js', defer: true }],
  },
  accentColor: '#1f56c7',
  colorScheme: 'light',
  // Static HTML output so the site deploys to Vercel, Netlify or any static host.
  renderStrategy: 'full-static',
  // Served under the Pilot app at /docs (Next rewrites /docs/* to this deployment).
  basePath: '/docs',
  banner: {
    content:
      'Pilot executes on XRPL Testnet and Devnet only. Mainnet is read-only. [See what is live →](/reference/status)',
    dismissable: true,
  },
  editLink: {
    link: 'https://github.com/alycz/pilot/edit/main/docs-site/src/pages/:path',
    text: 'Suggest changes to this page',
  },
  socials: [{ icon: 'github', link: 'https://github.com/alycz/pilot' }],
  topNav: [
    { text: 'Guide', link: '/introduction/what-is-pilot', match: '/introduction' },
    { text: 'MCP & API', link: '/mcp/overview', match: '/mcp' },
    { text: 'Trading harness', link: '/harness/overview', match: '/harness' },
    { text: 'Integrations', link: '/integrations', match: '/integrations' },
    { text: 'Reference', link: '/reference/operations', match: '/reference' },
  ],
  sidebar: [
    {
      text: 'Introduction',
      items: [
        { text: 'What is Pilot?', link: '/introduction/what-is-pilot' },
        { text: 'How it works', link: '/introduction/how-it-works' },
        { text: 'Security model', link: '/introduction/security' },
      ],
    },
    {
      text: 'Quickstart',
      items: [
        { text: 'Use the Pilot app', link: '/quickstart/app' },
        { text: 'Connect an AI client (MCP)', link: '/quickstart/mcp' },
        { text: 'Call the REST API', link: '/quickstart/api' },
        { text: 'Run Pilot locally', link: '/quickstart/local' },
      ],
    },
    {
      text: 'MCP & API',
      items: [
        { text: 'Overview', link: '/mcp/overview' },
        { text: 'MCP tools: search & execute', link: '/mcp/tools' },
        { text: 'REST API', link: '/mcp/rest' },
        { text: 'Authentication', link: '/mcp/authentication' },
        { text: 'Response envelope & errors', link: '/mcp/envelope' },
        { text: 'Executing transactions', link: '/mcp/transactions' },
        { text: 'Policy & delegation', link: '/mcp/policy' },
        { text: 'Venue catalog', link: '/mcp/venues' },
      ],
    },
    {
      text: 'Trading harness',
      items: [
        { text: 'Overview', link: '/harness/overview' },
        { text: 'Agent loop & tools', link: '/harness/agent' },
        { text: 'Typed intents', link: '/harness/intents' },
        { text: 'Card lifecycle', link: '/harness/lifecycle' },
        { text: 'Onboarding & delegation', link: '/harness/onboarding' },
        { text: 'Memory & personalization', link: '/harness/memory' },
        { text: 'Strategies', link: '/harness/strategies', badge: off },
        { text: 'Backtesting', link: '/harness/backtesting' },
        { text: 'Evals', link: '/harness/evals' },
      ],
    },
    {
      text: 'Integrations',
      items: [
        { text: 'Overview', link: '/integrations' },
        { text: 'Ledger', link: '/integrations/ledger', badge: built },
        { text: 'AWS', link: '/integrations/aws', badge: mock },
        { text: 'QuickNode', link: '/integrations/quicknode', badge: mock },
        { text: 'Mastercard (AP4M)', link: '/integrations/mastercard', badge: mock },
        { text: 'x402 payments', link: '/integrations/x402', badge: mock },
        { text: 'OpenRouter', link: '/integrations/openrouter', badge: built },
        { text: 'Wallets', link: '/integrations/wallets', badge: built },
        { text: 'Markdown vault', link: '/integrations/vault', badge: built },
        { text: 'Market data sources', link: '/integrations/data-sources', badge: built },
        { text: 'Hermes', link: '/integrations/hermes', badge: off },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'All operations', link: '/reference/operations' },
        { text: 'Environment variables', link: '/reference/environment' },
        { text: 'What is live', link: '/reference/status' },
        { text: 'Glossary', link: '/reference/glossary' },
      ],
    },
  ],
})
