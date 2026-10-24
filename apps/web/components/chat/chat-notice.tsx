import { AlertTriangle, ArrowRight, FlaskConical, LockKeyhole, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type ChatNoticeKind = "configuration" | "onboarding" | "proof" | "unavailable";

const demoReason: Record<ChatNoticeKind, string> = {
  onboarding: "No wallet session",
  proof: "Local wallet proof not configured",
  unavailable: "Wallet session unavailable",
  configuration: "Pilot configuration unavailable",
};

/**
 * Slim single-row band shown in the conversation bar while the visitor explores
 * the simulated demo. The prerequisite that keeps live chat off stays visible
 * in mono for developers, but it is not presented as an error.
 */
export function DemoBanner({ reason }: { reason: ChatNoticeKind }) {
  return (
    <div role="status" className="flex min-w-0 flex-1 items-center gap-3">
      <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center border border-primary/30 bg-primary-soft text-primary rounded-xl">
        <FlaskConical className="h-3.5 w-3.5" />
      </span>
      <p className="min-w-0 truncate text-[13px] leading-5 text-foreground">
        <span className="sm:hidden">Demo mode.</span>
        <span className="hidden sm:inline lg:hidden">You&apos;re in demo mode. Create an account to use your own wallet.</span>
        <span className="hidden text-[13px] lg:inline">Demo mode</span>
      </p>
      <Link
        href="/onboarding"
        className="link-dashed ml-auto inline-flex shrink-0 lg:hidden items-center gap-1.5 text-[13px] font-medium text-foreground pointer-coarse:min-h-11"
      >
        Get started <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

const noticeCopy: Record<ChatNoticeKind, { title: string; tone: "locked" | "blocked"; icon: LucideIcon }> = {
  onboarding: { title: "Chat is locked", tone: "locked", icon: LockKeyhole },
  proof: { title: "Wallet proof not configured", tone: "blocked", icon: LockKeyhole },
  unavailable: { title: "Wallet session unavailable", tone: "blocked", icon: AlertTriangle },
  configuration: { title: "Configuration unavailable", tone: "blocked", icon: AlertTriangle },
};

/**
 * Presentational wrapper for the chat gating notices. The gating decision
 * itself still comes from `chatSessionUi`; this only changes how it reads.
 */
export function ChatNotice({ kind, children }: { kind: ChatNoticeKind; children: ReactNode }) {
  const { title, tone, icon: Icon } = noticeCopy[kind];
  return (
    <div
      role="status"
      className={`mb-3 flex items-start gap-3 border px-3.5 py-3 text-xs leading-5 rounded-xl ${
        tone === "blocked"
          ? "border-approval/30 bg-approval/[0.06]"
          : "border-border bg-white/[0.03]"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center border rounded-xl ${
          tone === "blocked" ? "border-approval/30 text-approval" : "border-border text-muted-foreground"
        }`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
