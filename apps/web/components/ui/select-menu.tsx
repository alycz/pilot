"use client";

import { Check, ChevronDown } from "lucide-react";
import React, { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type SelectMenuOption<T extends string> = { value: T; label: string };

/**
 * Pilot's own dropdown: a button that opens a listbox styled like the rest of
 * the platform, instead of the browser's native select. Keyboard: arrows,
 * Home/End, Enter/Space to choose, Escape to close, and type to jump.
 */
export function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  display,
  size = "md",
  placement = "below",
  className = "",
}: {
  /** Accessible name, e.g. "Network focus". */
  label: string;
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Shown on the closed button; defaults to the selected option's label. */
  display?: ReactNode;
  /** "sm" matches compact table toolbars; "title" turns a page heading into the menu. */
  size?: "md" | "sm" | "title";
  /** "above" for controls near the bottom of the screen, such as the chat composer. */
  placement?: "below" | "above";
  className?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [active, setActive] = useState(selectedIndex);
  const selected = options[selectedIndex];

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  const openMenu = useCallback((index = selectedIndex) => {
    if (disabled) return;
    setActive(index);
    setOpen(true);
  }, [disabled, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (index: number) => {
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
    close(true);
  };

  const jumpTo = (key: string) => {
    const now = Date.now();
    const text = (now - typeahead.current.at < 600 ? typeahead.current.text : "") + key.toLowerCase();
    typeahead.current = { text, at: now };
    const start = text.length === 1 ? active + 1 : active;
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + offset) % options.length;
      if (options[index]!.label.toLowerCase().startsWith(text)) return index;
    }
    return undefined;
  };

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowUp" ? Math.max(0, selectedIndex - 1) : Math.min(options.length - 1, selectedIndex + 1));
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); setActive((index) => Math.min(options.length - 1, index + 1)); return;
      case "ArrowUp": event.preventDefault(); setActive((index) => Math.max(0, index - 1)); return;
      case "Home": event.preventDefault(); setActive(0); return;
      case "End": event.preventDefault(); setActive(options.length - 1); return;
      case "Enter":
      case " ": event.preventDefault(); choose(active); return;
      case "Escape": event.preventDefault(); event.stopPropagation(); close(true); return;
      case "Tab": setOpen(false); return;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const index = jumpTo(event.key);
          if (index !== undefined) setActive(index);
        }
    }
  };

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={size === "title" ? undefined : label}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onButtonKey}
        className={size === "title"
          ? `group inline-flex max-w-full min-w-0 items-center gap-3 rounded-lg border bg-card py-1.5 pl-4 pr-3 text-left text-foreground shadow-sm shadow-black/[0.03] transition hover:border-border-strong hover:bg-secondary/40 disabled:cursor-not-allowed ${open ? "border-border-strong" : "border-border"}`
          : `flex w-full min-w-0 items-center justify-between gap-2 border bg-card text-left rounded-md ${size === "sm" ? "h-8 px-2.5 text-xs" : "h-10 px-3 text-sm"} text-foreground transition hover:bg-foreground/[0.03] disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-11 ${open ? "border-border-strong" : "border-input"}`}
      >
        <span className="min-w-0 truncate">{display ?? selected?.label}</span>
        {size === "title" ? <span className="sr-only">, {label.toLowerCase()}</span> : null}
        <ChevronDown aria-hidden="true" className={`${size === "title" ? "size-5" : "size-3.5"} shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-option-${active}`}
          onKeyDown={onListKey}
          className={`pilot-select-menu absolute left-0 z-30 w-max min-w-full max-w-[min(22rem,90vw)] ${placement === "above" ? "bottom-[calc(100%+4px)] origin-bottom" : size === "title" ? "top-[calc(100%+8px)]" : "top-[calc(100%+4px)]"} max-h-72 overflow-y-auto border border-border-strong bg-card py-1 shadow-lg shadow-black/[0.08] outline-none rounded-xl`}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                id={`${id}-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={isSelected}
                onPointerMove={() => setActive(index)}
                onClick={() => choose(index)}
                className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[13px] ${index === active ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground"} ${isSelected ? "text-foreground" : ""}`}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {isSelected ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-[color-mix(in_oklab,var(--primary)_85%,var(--foreground))]" /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
