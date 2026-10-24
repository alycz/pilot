const clients = [
  { name: "Pilot workspace", detail: "Built by us on the same API.", link: "Typed client", built: true },
  { name: "Payments app", detail: "Sends RLUSD and XRP within the user's limits.", link: "REST", built: false },
  { name: "Trading website", detail: "Its backend calls the REST API for quotes and swaps.", link: "REST", built: false },
  { name: "Trading bot", detail: "Calls REST or MCP; the strategy is the developer's.", link: "REST · MCP", built: false },
  { name: "Portfolio tracker", detail: "Reads accounts, balances and positions.", link: "REST", built: false },
  { name: "Research assistant", detail: "Uses read operations over MCP, without trading.", link: "MCP", built: false },
] as const;

const sources = [
  { name: "XRP Ledger", detail: "Balances, orders, XRP/RLUSD price", link: "Reads · submits" },
  { name: "XRPL.to · XRPSCAN · Bithomp", detail: "Tokens, accounts, history", link: "Reads" },
  { name: "XRPL docs", detail: "Transaction rules", link: "Reads" },
  { name: "Hyperliquid", detail: "XRP perps context", link: "Reads" },
] as const;

function Connector({ label, dashed, accent, className = "flex" }: { label: string; dashed?: boolean; accent?: boolean; className?: string }) {
  return (
    <div className={`${className} flex-col items-center`} aria-hidden="true">
      <span
        className={`h-7 w-0 border-l ${dashed ? "border-dashed rounded-xl" : ""} ${accent ? "border-primary" : "border-border-strong"}`}
      />
      <span className="label-mono my-1">{label}</span>
      <span className={`h-5 w-0 border-l ${dashed ? "border-dashed rounded-xl" : ""} ${accent ? "border-primary" : "border-border-strong"}`} />
      <svg viewBox="0 0 10 6" className={`h-1.5 w-2.5 ${accent ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "text-border-strong"}`} fill="currentColor">
        <path d="M0 0h10L5 6z" />
      </svg>
    </div>
  );
}

export function ArchitectureDiagram() {
  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">
        Architecture: the Pilot workspace, built by us, calls the Pilot MCP and REST API through a typed client. Example applications that do
        not exist yet, such as a payments app, a trading website, a trading bot, a portfolio tracker and a research assistant, would connect over
        REST or MCP. The engine reads from and submits to the XRP Ledger, and reads token and account data from XRPL.to, XRPSCAN and Bithomp,
        transaction rules from the XRPL docs, and XRP perps context from Hyperliquid.
      </figcaption>

      <div aria-hidden="true">
        <p className="label-mono mb-3">Applications</p>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {clients.map((client) => (
            <li key={client.name} className="flex min-w-0 flex-col">
              <div
                className={`flex h-full flex-col p-4 ${
                  client.built ? "bracket bracket-accent border border-primary-soft-border bg-primary-soft rounded-xl" : "border border-dashed border-border-strong bg-card/60 rounded-xl"
                }`}
              >
                <span
                  className={`self-start border px-1.5 py-0.5 text-xs rounded ${
                    client.built ? "border-primary/40 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "border-border text-muted-foreground"
                  }`}
                >
                  {client.built ? "Built" : "Example"}
                </span>
                <p className="mt-3 text-sm font-medium text-foreground">{client.name}</p>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{client.detail}</p>
              </div>
              <Connector label={client.link} dashed={!client.built} accent={client.built} className="hidden lg:flex" />
            </li>
          ))}
        </ul>
        <Connector label="MCP · REST · typed client" className="flex lg:hidden mt-1" />

        <div className="bracket bracket-light relative mt-1 border border-border-strong bg-card px-5 py-6 text-center sm:py-8 rounded-xl">
          <p className="label-mono">One engine</p>
          <p className="mt-2 text-xl font-normal tracking-[-0.02em] text-foreground sm:text-2xl">Pilot MCP &amp; REST API</p>
          <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
            Same operations, same checks, whichever door an app comes through: read the market, build the trade, check limits, wait for
            approval, confirm on the ledger.
          </p>
        </div>

        <Connector label="Reads · submits" className="flex lg:hidden" />
        <ul className="mt-1 grid gap-3 sm:grid-cols-2 lg:mt-0 lg:grid-cols-4">
          {sources.map((source) => (
            <li key={source.name} className="flex min-w-0 flex-col">
              <Connector label={source.link} className="hidden lg:flex" />
              <div className="h-full border border-border bg-card p-4 rounded-xl">
                <p className="text-sm font-medium text-foreground">{source.name}</p>
                <p className="mt-1.5 text-[13px] text-muted-foreground">{source.detail}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="label-mono mt-3 text-right">Where the data comes from</p>
      </div>
    </figure>
  );
}
