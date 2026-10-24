import type { CardEvent, Intent } from "@pilot/contracts";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type CardTone = "neutral" | "active" | "success" | "approval" | "danger";

const toneStyles: Record<CardTone, { border: string; icon: string; badge: string }> = {
  neutral: {
    border: "border-border",
    icon: "border-border text-muted-foreground",
    badge: "border-border-strong bg-white/[0.03] text-muted-foreground",
  },
  active: {
    border: "border-border",
    icon: "border-info/30 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))]",
    badge: "border-info/35 bg-info/10 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))]",
  },
  success: {
    border: "border-border",
    icon: "border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
    badge: "border-executed/35 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
  },
  approval: {
    border: "border-approval/35",
    icon: "border-approval/35 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
    badge: "border-approval/40 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
  },
  danger: {
    border: "border-destructive/35",
    icon: "border-destructive/35 text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))]",
    badge: "border-destructive/40 bg-destructive/10 text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))]",
  },
};

export function CardFrame({
  event,
  title,
  subtitle,
  icon: Icon,
  tone = "neutral",
  children,
  footer,
}: {
  event: CardEvent;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  tone?: CardTone;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const style = toneStyles[tone];
  return (
    <article
      data-card-state={event.state}
      aria-label={`${title}: ${intentLabel(event.intent)}`}
      className={`min-w-0 overflow-hidden border ${style.border} bg-card`}
    >
      <div className="flex min-w-0 items-start gap-3 p-4">
        <span className={`grid h-8 w-8 shrink-0 place-items-center border bg-white/[0.02] ${style.icon}`}>
          <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          {/* The state tag always sits under the subtitle, so every card reads the same. */}
          <h3 className="text-sm font-medium tracking-tight">{title}</h3>
          <p className="mt-0.5 text-balance break-words text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
          <span className={`mt-2 inline-block border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${style.badge}`}>
            {event.state.replaceAll("_", " ")}
          </span>
          <p className="mt-3 break-words font-mono text-xs uppercase leading-5 tracking-wide text-foreground/90">{intentLabel(event.intent)}</p>
        </div>
      </div>
      {children ? <div className="border-t border-border px-4 py-3.5">{children}</div> : null}
      {footer ? <div className="border-t border-border bg-white/[0.015] px-4 py-3">{footer}</div> : null}
    </article>
  );
}
export function intentLabel(intent: Intent): string {
  switch (intent.kind) {
    case "swap":
      return `${intent.side === "sell" ? "Sell" : "Buy"} ${intent.amount} ${intent.side === "sell" ? intent.sell.currency : intent.buy.currency} · ${intent.sell.currency}/${intent.buy.currency}`;
    case "limit":
      return `Limit ${intent.sell_amount} ${intent.sell.currency} → ${intent.buy_amount} ${intent.buy.currency}`;
    case "cancel":
      return `Cancel offer #${intent.offer_sequence}`;
    case "lp_deposit":
      return `Add ${intent.amount} ${intent.asset.currency} to ${intent.asset.currency}/${intent.asset2.currency}`;
    case "lp_withdraw":
      return `Withdraw ${intent.amount} ${intent.asset.currency} from ${intent.asset.currency}/${intent.asset2.currency}`;
    case "vault_deposit":
      return `Deposit ${intent.amount} ${intent.asset.currency} into vault ${shorten(intent.vault_id, 6, 6)}`;
    case "pay":
      return `Pay ${intent.amount} ${intent.asset.currency} to ${shorten(intent.to)}`;
    case "fund_budget":
      return `Fund budget with ${intent.amount} ${intent.asset.currency}`;
    case "x402_call":
      return `Premium data call · max ${intent.max_price_drops} drops`;
    case "ap4m_purchase":
      return "AP4M purchase unavailable until MP4";
  }
}

export function shorten(value: string, leading = 7, trailing = 5) {
  if (value.length <= leading + trailing + 1) return value;
  return `${value.slice(0, leading)}…${value.slice(-trailing)}`;
}

export function DetailGrid({ items }: { items: { label: string; value: string; mono?: boolean }[] }) {
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-px border border-border bg-border">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 bg-card px-3 py-2.5">
          <dt className="label-mono text-[10px]">{item.label}</dt>
          <dd className={`mt-1 break-words text-xs ${item.mono ? "font-mono" : "font-medium"}`}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
