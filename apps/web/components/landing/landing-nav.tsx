"use client";

import { ArrowRight, Menu, Navigation, X } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { integrationLinks } from "@/components/integrations/integration-links";
import { IntegrationsMenu } from "@/components/integrations/integrations-menu";
import type { IntegrationSlug } from "@/components/integrations/types";
import { DOCS_PATH } from "@/lib/docs-origin";

import { DocsLink } from "./docs-link";
import { useActiveSection } from "./landing-motion";

const anchors = [
  { href: "#api", label: "MCP & API" },
  { href: "#pilot", label: "Workspace" },
  { href: "#architecture", label: "Apps" },
  { href: "#learning", label: "Memory" },
  { href: "#use-cases", label: "Use cases" },
  { href: "#safety", label: "Safety" },
  { href: "#roadmap", label: "Roadmap" },
] as const;

const sectionIds = anchors.map((anchor) => anchor.href.slice(1));
const noSections: readonly string[] = [];

export function LandingBrand() {
  return (
    <Link href="/" className="flex h-9 shrink-0 items-center gap-1.5 leading-none text-primary focus-visible:outline-offset-4 pointer-coarse:h-11" aria-label="Pilot home">
      <Navigation className="h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden="true" />
      <span className="block text-[15px] font-medium leading-none tracking-tight">Pilot</span>
    </Link>
  );
}

export function LaunchButton({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/chat"
      className={`bracket bracket-light inline-flex h-9 items-center gap-2 border border-border-strong bg-white/[0.04] px-3.5 text-[13px] pointer-coarse:h-11 text-foreground transition hover:bg-white/[0.08] rounded-md ${className}`}
    >
      Launch Pilot
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

/**
 * The site navigation. On the landing page the section links scroll in place;
 * on an integration page (`current` set) they lead back to those sections.
 */
export function LandingNav({ current }: { current?: IntegrationSlug } = {}) {
  const onLanding = !current;
  const tracked = useActiveSection(onLanding ? sectionIds : noSections);
  const active = onLanding ? tracked : undefined;
  const hrefFor = (href: string) => (onLanding ? href : `/${href}`);
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
          <ul className="flex h-9 items-center gap-6 pointer-coarse:h-11">
            {anchors.map((anchor) => (
              <li key={anchor.href} className="flex h-9 items-center pointer-coarse:h-11">
                <a
                  href={hrefFor(anchor.href)}
                  aria-current={active === anchor.href.slice(1) ? "location" : undefined}
                  className={`group relative inline-flex h-9 items-center justify-center pointer-coarse:h-11 leading-none text-[13px] transition-colors duration-300 hover:text-foreground ${
                    active === anchor.href.slice(1) ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute inset-x-0 bottom-1.5 h-[1.5px] origin-left bg-primary transition-transform duration-300 motion-reduce:transition-none pointer-coarse:bottom-2.5 ${active === anchor.href.slice(1) ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100 group-hover:bg-border-strong"}`}
                  />
                  {anchor.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <DocsLink className="hidden lg:inline-flex" />
          <IntegrationsMenu current={current} className="hidden lg:block" />
          <LaunchButton />
          <div ref={mobileRootRef} className="relative lg:hidden">
            <button
              ref={mobileTriggerRef}
              type="button"
              aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileOpen}
              aria-controls="landing-mobile-menu"
              onClick={() => setMobileOpen((value) => !value)}
              className="grid h-9 w-9 place-items-center border border-border pointer-coarse:h-11 pointer-coarse:w-11 text-muted-foreground hover:text-foreground rounded-md"
            >
              {mobileOpen ? <X className="h-4 w-4" aria-hidden="true" /> : <Menu className="h-4 w-4" aria-hidden="true" />}
            </button>
            {mobileOpen ? (
              <nav
                id="landing-mobile-menu"
                aria-label="Sections and integrations (mobile)"
                className="absolute right-0 top-[calc(100%+0.5rem)] max-h-[min(75vh,36rem)] w-72 overflow-y-auto border border-border-strong bg-popover shadow-xl shadow-black/[0.08] rounded-xl"
              >
                <ul className="border-b border-border py-1">
                  <li>
                    <a
                      href={DOCS_PATH}
                      onClick={() => setMobileOpen(false)}
                      className="block min-h-11 px-4 py-2.5 hover:bg-white/[0.04] rounded-md"
                    >
                      <span className="block text-sm text-foreground">Docs</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">MCP, API, harness and integrations</span>
                    </a>
                  </li>
                </ul>
                <p className="label-mono px-4 pb-2 pt-4">Integrations</p>
                <ul className="border-b border-border">
                  {integrationLinks.map((item) => (
                    <li key={item.slug}>
                      <Link
                        href={item.href}
                        aria-current={current === item.slug ? "page" : undefined}
                        onClick={() => setMobileOpen(false)}
                        className={`block min-h-11 px-4 py-2.5 hover:bg-white/[0.04] rounded-md ${current === item.slug ? "bg-white/[0.05]" : ""}`}
                      >
                        <span className="block text-sm text-foreground">{item.label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{item.detail}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="label-mono px-4 pb-2 pt-4">{onLanding ? "On this page" : "Overview"}</p>
                <ul className="pb-2">
                  {anchors.map((anchor) => (
                    <li key={anchor.href}>
                      <a
                        href={hrefFor(anchor.href)}
                        onClick={() => setMobileOpen(false)}
                        className="flex min-h-11 items-center px-4 py-2 text-[13px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground rounded-md"
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
