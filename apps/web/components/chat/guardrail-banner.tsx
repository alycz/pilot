import type { GuardrailNotice } from "@pilot/agent/guardrail-notice";
import type { BlockedFieldKind } from "@pilot/contracts";
import { ShieldAlert } from "lucide-react";
import React from "react";

const BLOCKED_FIELD_LABELS = {
  "amendment-name": "amendment name",
  "asset-class": "asset class",
  "credential-type": "credential type",
  "ledger-data": "ledger data",
  "did-document": "DID document",
  domain: "domain",
  "memo-data": "memo data",
  "memo-type": "memo type",
  "mptoken-metadata": "MPT metadata",
  provider: "provider name",
  uri: "URI",
  "purchase-data": "purchase data",
  "document-title": "document title",
  "document-snippet": "document snippet",
  "document-source": "document source",
  "document-url": "document URL",
  "mastercard-content": "Mastercard content",
  "market-coin": "market coin",
  "margin-mode": "margin mode",
  "token-name": "token name",
  "token-description": "token description",
  "token-domain": "token domain",
  "token-icon": "token icon",
  "merchant-response": "merchant response",
} satisfies Record<BlockedFieldKind, string>;

export function GuardrailBanner({
  notices,
}: {
  notices: readonly GuardrailNotice[];
}) {
  const uniqueNotices = deduplicateNotices(notices);
  const kinds = deduplicateKinds(uniqueNotices);
  if (kinds.length === 0) return null;

  const labels = kinds.map((kind) => BLOCKED_FIELD_LABELS[kind]);
  const includesMock = uniqueNotices.some((notice) => notice.provider === "mock");

  return (
    <section
      aria-label="AWS Bedrock Guardrails notice"
      className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.055] px-4 py-3 text-foreground/90"
      role="status"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-400/10 text-amber-300">
          <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold leading-5">
              {labels.length === 1
                ? `AWS Bedrock Guardrails blocked a prompt injection hidden in this ${labels[0]}.`
                : `AWS Bedrock Guardrails blocked prompt injections hidden in these fields: ${formatList(labels)}.`}
            </p>
            {includesMock ? (
              <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-200">
                Mock screening
              </span>
            ) : null}
          </div>
          <details className="mt-2 text-xs leading-5 text-muted-foreground">
            <summary className="cursor-pointer font-semibold text-foreground/75 hover:text-foreground">
              How screening works
            </summary>
            <p className="mt-1.5">
              Potentially unsafe text was redacted before Pilot used it. This notice shows only fixed field categories, never the blocked text or its raw path.
            </p>
          </details>
        </div>
      </div>
    </section>
  );
}

function deduplicateNotices(
  notices: readonly GuardrailNotice[],
): GuardrailNotice[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const safeKinds = notice.blocked_field_kinds.filter(isBlockedFieldKind);
    if (safeKinds.length === 0) return false;
    const key = [
      notice.provider,
      notice.caveat,
      notice.fields_checked,
      notice.fields_blocked,
      [...safeKinds].sort().join(","),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateKinds(
  notices: readonly GuardrailNotice[],
): BlockedFieldKind[] {
  const seen = new Set<BlockedFieldKind>();
  for (const notice of notices) {
    for (const kind of notice.blocked_field_kinds) {
      if (isBlockedFieldKind(kind)) seen.add(kind);
    }
  }
  return [...seen];
}

function isBlockedFieldKind(kind: string): kind is BlockedFieldKind {
  return Object.prototype.hasOwnProperty.call(BLOCKED_FIELD_LABELS, kind);
}

function formatList(labels: readonly string[]): string {
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}
