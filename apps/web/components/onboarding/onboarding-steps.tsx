"use client";

import { Check } from "lucide-react";

export const ONBOARDING_STEPS = [
  { id: "wallet", label: "Wallet" },
  { id: "ai", label: "AI optional" },
  { id: "access", label: "Access" },
  { id: "fund", label: "Fund" },
  { id: "acquire", label: "Acquire" },
  { id: "delegate", label: "Delegate" },
  { id: "verify", label: "Verify" },
  { id: "mandate", label: "Mandate" },
  { id: "ready", label: "Trading" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

function visibleSteps(includeAcquire: boolean) {
  return includeAcquire
    ? ONBOARDING_STEPS
    : ONBOARDING_STEPS.filter(({ id }) => id !== "acquire");
}

export function stepIndex(step: OnboardingStepId, includeAcquire = true) {
  return visibleSteps(includeAcquire).findIndex(({ id }) => id === step);
}

export function onboardingProgressSteps(
  current: OnboardingStepId,
  includeAcquire = true,
) {
  const steps = visibleSteps(includeAcquire);
  const basicSetup = current === "wallet" || current === "ai" || current === "access";
  return steps.filter(({ id }) =>
    basicSetup
      ? id === "wallet" || id === "ai" || id === "access"
      : id !== "wallet" && id !== "ai" && id !== "access"
  );
}

export function OnboardingSteps({
  current,
  includeAcquire = false,
}: {
  current: OnboardingStepId;
  includeAcquire?: boolean;
}) {
  const steps = onboardingProgressSteps(current, includeAcquire);
  const currentIndex = steps.findIndex(({ id }) => id === current);
  const basicSetup = current === "wallet" || current === "ai" || current === "access";
  const gridColumns = basicSetup
    ? "grid-cols-3"
    : includeAcquire
      ? "grid-cols-6"
      : "grid-cols-5";
  return (
    <ol
      aria-label={basicSetup ? "Basic setup progress" : "Optional trading setup progress"}
      className={`grid ${gridColumns} gap-1 sm:gap-1.5`}
    >
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li className="min-w-0" key={step.id}>
            <div
              aria-current={active ? "step" : undefined}
              className={`h-[3px] ${active ? "bg-primary" : done ? "bg-foreground/55" : "bg-border-strong"}`}
            />
            <span className={`mt-2.5 flex items-start gap-1 font-mono text-[10px] uppercase leading-tight tracking-[0.04em] sm:text-[11px] sm:tracking-[0.06em] lg:text-[10px] lg:tracking-[0.02em] xl:text-[11px] xl:tracking-[0.06em] ${active ? "text-foreground" : "text-muted-foreground"}`}>
              {done ? <Check className="mt-px hidden size-3 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] sm:block" aria-hidden="true" /> : null}
              <span>{step.label}</span>{done ? <span className="sr-only"> (complete)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
