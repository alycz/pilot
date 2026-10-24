"use client";

import { ArrowRight, Menu, Navigation2, X } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { integrationLinks } from "@/components/integrations/integration-links";
import { IntegrationsMenu } from "@/components/integrations/integrations-menu";

import { useActiveSection } from "./landing-motion";

const anchors = [
  { href: "#harbor", label: "Harbor" },
  { href: "#pilot", label: "Workspace" },
  { href: "#architecture", label: "Architecture" },
  { href: "#learning", label: "Learning" },
  { href: "#use-cases", label: "Use cases" },
  { href: "#safety", label: "Safety" },
  { href: "#roadmap", label: "Roadmap" },
] as const;

const sectionIds = anchors.map((anchor) => anchor.href.slice(1));

export function LandingBrand() {
  return (
    <Link href="/" className="flex h-9 shrink-0 items-center gap-2.5 leading-none focus-visible:outline-offset-4 pointer-coarse:h-11" aria-label="Workspace home">
      <Navigation2 className="h-4 w-4 shrink-0 rotate-45 text-foreground" strokeWidth={1.75} aria-hidden="true" />
      <span className="block text-[15px] font-medium leading-none tracking-tight">Workspace</span>
    </Link>
  );
}

export function LaunchButton({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/chat"
      className={`bracket bracket-light inline-flex h-9 items-center gap-2 border border-border-strong bg-white/[0.04] px-3.5 font-mono text-[11px] uppercase tracking-wide pointer-coarse:h-11 text-foreground transition hover:bg-white/[0.08] ${className}`}
    >
      Launch workspace
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

export function LandingNav() {
  const active = useActiveSection(sectionIds);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileRootRef = useRef<HTMLDivElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!mobileRootRef.current?.contains(event.target as Node)) setMobileOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      mobileTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [mobileOpen]);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/92 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6 lg:h-16 lg:px-8">
        <LandingBrand />
        <nav aria-label="Sections" className="ml-4 hidden h-9 items-center border-l border-border pl-8 lg:flex pointer-coarse:h-11">
          <ul className="flex h-9 items-center gap-5 pointer-coarse:h-11">
            {anchors.map((anchor) => (
              <li key={anchor.href} className="flex h-9 items-center pointer-coarse:h-11">
                <a
                  href={anchor.href}
                  aria-current={active === anchor.href.slice(1) ? "location" : undefined}
                  className={`group relative inline-flex h-9 min-w-11 items-center justify-center font-mono pointer-coarse:h-11 leading-none text-[11px] uppercase tracking-[0.06em] transition-colors duration-300 hover:text-foreground ${
                    active === anchor.href.slice(1) ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute -left-2.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 bg-primary transition-all duration-300 ${active === anchor.href.slice(1) ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
                  />
                  {anchor.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <IntegrationsMenu className="hidden lg:block" />
          <LaunchButton />
          <div ref={mobileRootRef} className="relative lg:hidden">
            <button
              ref={mobileTriggerRef}
              type="button"
              aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileOpen}
              aria-controls="landing-mobile-menu"
              onClick={() => setMobileOpen((value) => !value)}
              className="grid h-9 w-9 place-items-center border border-border pointer-coarse:h-11 pointer-coarse:w-11 text-muted-foreground hover:text-foreground"
            >
              {mobileOpen ? <X className="h-4 w-4" aria-hidden="true" /> : <Menu className="h-4 w-4" aria-hidden="true" />}
            </button>
            {mobileOpen ? (
              <nav
                id="landing-mobile-menu"
                aria-label="Sections and integrations (mobile)"
                className="absolute right-0 top-[calc(100%+0.5rem)] max-h-[min(75vh,36rem)] w-72 overflow-y-auto border border-border-strong bg-popover shadow-xl shadow-black/[0.08]"
              >
                <p className="label-mono px-4 pb-2 pt-4">Integrations</p>
                <ul className="border-b border-border">
                  {integrationLinks.map((item) => (
                    <li key={item.slug}>
                      <Link
                        href={item.href}
                        onClick={() => setMobileOpen(false)}
                        className="block min-h-11 px-4 py-2.5 hover:bg-white/[0.04]"
                      >
                        <span className="block text-sm text-foreground">{item.label}</span>
                        <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{item.detail}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="label-mono px-4 pb-2 pt-4">On this page</p>
                <ul className="pb-2">
                  {anchors.map((anchor) => (
                    <li key={anchor.href}>
                      <a
                        href={anchor.href}
                        onClick={() => setMobileOpen(false)}
                        className="flex min-h-11 items-center px-4 py-2 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                      >
                        {anchor.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}
