"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/*
 * Token helpers: colour is applied with plain spans so the sample needs no
 * syntax-highlighting dependency.
 */
const K = ({ children }: { children: ReactNode }) => <span className="text-info">{children}</span>;
const S = ({ children }: { children: ReactNode }) => <span className="text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">{children}</span>;
const C = ({ children }: { children: ReactNode }) => <span className="text-muted-foreground">{children}</span>;
const F = ({ children }: { children: ReactNode }) => <span className="text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]">{children}</span>;

const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

const samples = [
  {
    id: "mcp",
    label: "MCP",
    caption: "Agents call Harbor's execute tool at {HARBOR_URL}/mcp",
    body: (
      <>
        <C>{"// tools/call → Harbor MCP server"}</C>
        {"\n{\n  "}
        <K>&quot;name&quot;</K>: <S>&quot;execute&quot;</S>,{"\n  "}
        <K>&quot;arguments&quot;</K>: {"{\n    "}
        <K>&quot;code&quot;</K>: <S>&quot;return await </S>
        <F>harbor.venues.compare</F>
        <S>{"({"}</S>
        {"\n      "}
        <S>network: &apos;testnet&apos;,</S>
        {"\n      "}
        <S>sell: {"{ currency: 'XRP' }"},</S>
        {"\n      "}
        <S>{`buy: { currency: 'RLUSD', issuer: '${RLUSD_ISSUER}' },`}</S>
        {"\n      "}
        <S>amount: &apos;100&apos;, side: &apos;sell&apos;</S>
        {"\n    "}
        <S>{"})\""}</S>
        {"\n  }\n}"}
      </>
    ),
  },
  {
    id: "rest",
    label: "REST",
    caption: "Apps call the same operation over HTTPS",
    body: (
      <>
        <F>curl</F> -X POST <S>&quot;$HARBOR_URL/api/ops/venues.compare&quot;</S> \{"\n  "}
        -H <S>&quot;Authorization: Bearer $HARBOR_API_KEY&quot;</S> \{"\n  "}
        -H <S>&quot;Content-Type: application/json&quot;</S> \{"\n  "}
        -d <S>&apos;</S>
        {"{\n    "}
        <K>&quot;network&quot;</K>: <S>&quot;testnet&quot;</S>,{"\n    "}
        <K>&quot;sell&quot;</K>: {"{ "}
        <K>&quot;currency&quot;</K>: <S>&quot;XRP&quot;</S>
        {" },\n    "}
        <K>&quot;buy&quot;</K>: {"{ "}
        <K>&quot;currency&quot;</K>: <S>&quot;RLUSD&quot;</S>, <K>&quot;issuer&quot;</K>: <S>&quot;{RLUSD_ISSUER}&quot;</S>
        {" },\n    "}
        <K>&quot;amount&quot;</K>: <S>&quot;100&quot;</S>,{"\n    "}
        <K>&quot;side&quot;</K>: <S>&quot;sell&quot;</S>
        {"\n  }"}
        <S>&apos;</S>
      </>
    ),
  },
] as const;

export function CodeSample() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = samples.length - 1;
    let next: number | undefined;
    if (event.key === "ArrowRight") next = active === last ? 0 : active + 1;
    if (event.key === "ArrowLeft") next = active === 0 ? last : active - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  const sample = samples[active];

  return (
    <div className="bracket flex min-w-0 flex-col border border-border-strong bg-card">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border pr-3">
        <div role="tablist" aria-label="Integration surface" className="flex">
          {samples.map((entry, index) => {
            const selected = index === active;
            return (
              <button
                key={entry.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`code-tab-${entry.id}`}
                aria-selected={selected}
                aria-controls={`code-panel-${entry.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(index)}
                onKeyDown={onKeyDown}
                className={`h-11 border-r border-border px-4 font-mono text-[11px] uppercase tracking-[0.06em] transition focus-visible:outline-offset-[-2px] ${
                  selected ? "bg-white/[0.05] text-foreground shadow-[inset_0_-1.5px_0_var(--primary)]" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
        <span className="label-mono hidden truncate text-[10px] sm:block">venues.compare · XRP → RLUSD</span>
      </div>
      <div role="tabpanel" id={`code-panel-${sample.id}`} aria-labelledby={`code-tab-${sample.id}`} className="flex min-w-0 flex-1 flex-col">
        <pre tabIndex={0} aria-label={`${sample.label} example`} className="flex-1 overflow-x-auto whitespace-pre px-4 py-5 font-mono text-[12px] leading-6 text-foreground focus-visible:outline-offset-[-2px] sm:px-5 [scrollbar-width:thin]">
          <code>{sample.body}</code>
        </pre>
        <p className="label-mono mt-auto flex items-center justify-between gap-3 border-t border-border bg-[color-mix(in_srgb,var(--foreground)_2.5%,var(--card))] px-4 py-3 text-[10px] sm:px-5">
          <span>{sample.caption}</span>
        </p>
      </div>
    </div>
  );
}
