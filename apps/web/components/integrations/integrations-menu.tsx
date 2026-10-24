"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useId, useRef, useState } from "react";

import { integrationLinks } from "./integration-links";
import type { IntegrationSlug } from "./types";

export function IntegrationsMenu({
  current,
  align = "end",
  className = "",
}: {
  current?: IntegrationSlug;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const id = useId();
  const menuId = `integrations-menu-${id.replaceAll(":", "")}`;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  const focusItem = (index: number) => {
    const count = integrationLinks.length;
    itemRefs.current[(index + count) % count]?.focus();
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => focusItem(event.key === "ArrowDown" ? 0 : -1));
        }}
        className="inline-flex min-h-11 items-center gap-1.5 px-2 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:text-foreground aria-expanded:text-foreground"
      >
        Integrations
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Integrations"
          className={`absolute top-[calc(100%+0.5rem)] z-50 w-72 border border-border-strong bg-popover p-1.5 shadow-xl shadow-black/[0.08] ${
            align === "start" ? "left-0" : "right-0"
          }`}
          onKeyDown={(event) => {
            const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusItem(currentIndex < 0 ? 0 : currentIndex + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusItem(currentIndex < 0 ? -1 : currentIndex - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusItem(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focusItem(-1);
            }
          }}
        >
          {integrationLinks.map((item, index) => (
            <Link
              key={item.slug}
              ref={(node) => { itemRefs.current[index] = node; }}
              role="menuitem"
              href={item.href}
              aria-current={current === item.slug ? "page" : undefined}
              onClick={() => setOpen(false)}
              className={`bracket-hover block min-h-11 border-b border-border px-3 py-2.5 last:border-b-0 hover:bg-white/[0.04] focus-visible:outline-offset-[-2px] ${
                current === item.slug ? "bracket bracket-accent bg-white/[0.05]" : ""
              }`}
            >
              <span className="block text-sm text-foreground">{item.label}</span>
              <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {item.detail}
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
