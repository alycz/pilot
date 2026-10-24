import type { IntegrationSlug } from "./types";

export const integrationLinks: readonly {
  slug: IntegrationSlug;
  href: `/integrations/${IntegrationSlug}`;
  label: string;
  detail: string;
}[] = [
  {
    slug: "mastercard",
    href: "/integrations/mastercard",
    label: "Mastercard AP4M",
    detail: "Bounded agent purchases",
  },
  {
    slug: "aws",
    href: "/integrations/aws",
    label: "AWS trust layer",
    detail: "Screening, models and keys",
  },
  {
    slug: "quicknode",
    href: "/integrations/quicknode",
    label: "QuickNode",
    detail: "Transport and watchdog",
  },
  {
    slug: "ledger",
    href: "/integrations/ledger",
    label: "Ledger",
    detail: "Owner-signing simulation",
  },
] as const;
