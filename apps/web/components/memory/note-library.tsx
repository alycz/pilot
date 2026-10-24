"use client";

import {
  BookOpenText,
  CalendarDays,
  FileText,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { MemoryNote, MemoryNoteKind } from "./types";

const kindStyles: Record<MemoryNoteKind, { label: string; className: string }> = {
  profile: { label: "Profile", className: "border-chart-4/30 bg-chart-4/[0.08] text-chart-4" },
  policy: { label: "Policy", className: "border-approval/30 bg-approval/[0.06] text-[color-mix(in_srgb,var(--approval)_82%,var(--foreground))]" },
  journal: { label: "Journal", className: "border-info/30 bg-info/[0.08] text-info" },
  trade: { label: "Trade", className: "border-executed/30 bg-executed/[0.08] text-executed" },
  venue: { label: "Venue", className: "border-border-strong bg-white/[0.04] text-foreground/85" },
  token: { label: "Token", className: "border-border-strong bg-white/[0.04] text-muted-foreground" },
  reflection: { label: "Reflection", className: "border-chart-4/30 bg-chart-4/[0.08] text-chart-4" },
};

export function NoteLibrary({
  notes,
  selectedId,
  onSelect,
}: {
  notes: MemoryNote[];
  selectedId: string;
  onSelect: (noteId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return notes;
    return notes.filter((note) =>
      [note.title, note.summary, note.path, ...note.tags]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [notes, query]);

  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = filtered.findIndex((note) => note.id === selectedId);
  const [focusIndex, setFocusIndex] = useState(0);
  // Roving tabindex: one card is tabbable; arrow keys move focus within the strip.
  const activeIndex = filtered.length === 0
    ? -1
    : Math.min(focusIndex >= 0 && focusIndex < filtered.length ? focusIndex : Math.max(selectedIndex, 0), filtered.length - 1);

  const moveFocus = (next: number) => {
    if (filtered.length === 0) return;
    const index = (next + filtered.length) % filtered.length;
    setFocusIndex(index);
    cards.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(filtered.length - 1);
    }
  };

  return (
    <section className="min-w-0 border border-border bg-card" aria-labelledby="notes-title">
      <div className="flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <BookOpenText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="notes-title" className="text-[1.25rem] font-normal leading-tight tracking-[-0.02em]">Vault notes</h2>
            <p className="label-mono mt-1.5">{notes.length} linked Markdown files · arrow keys to browse</p>
          </div>
        </div>
        <label className="bracket bracket-focus relative block w-full sm:w-72">
          <span className="sr-only">Search memory notes</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFocusIndex(-1);
            }}
            placeholder="Search notes and tags"
            className="h-10 w-full min-w-0 border border-input bg-background/60 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/75 focus-visible:border-primary/60 focus-visible:outline-none"
          />
        </label>
      </div>

      {filtered.length > 0 ? (
        <div className="overflow-hidden">
          {/* Cells draw their right/bottom hairlines; the negative margin hides the outer edge. */}
          <div className="-mb-px -mr-px grid sm:grid-cols-2 xl:grid-cols-4" role="list" aria-label="Memory notes">
            {filtered.map((note, index) => {
              const selected = note.id === selectedId;
              const style = kindStyles[note.kind];
              return (
                <div key={note.id} role="listitem" className="min-w-0 border-b border-r border-border">
                  <button
                    ref={(element) => {
                      cards.current[index] = element;
                    }}
                    type="button"
                    tabIndex={index === activeIndex ? 0 : -1}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      setFocusIndex(index);
                      onSelect(note.id);
                    }}
                    onFocus={() => setFocusIndex(index)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    className={`group flex h-full w-full min-w-0 items-start gap-3 px-4 py-3.5 text-left transition focus-visible:outline-offset-[-2px] ${
                      selected ? "bracket bracket-accent bg-white/[0.05]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <span aria-hidden="true" className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center border ${style.className}`}>
                      {note.kind === "policy" ? <ShieldCheck className="h-3.5 w-3.5" /> : note.kind === "reflection" ? <Sparkles className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-start gap-2">
                        <span className="line-clamp-1 min-w-0 text-sm font-medium leading-5 text-foreground">{note.title}</span>
                        <span className={`ml-auto mt-px shrink-0 border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${style.className}`}>{style.label}</span>
                      </span>
                      <span className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">{note.summary}</span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-4 py-10 text-center">
          <Search className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">No notes found</p>
          <p className="label-mono mt-1.5">Try a title, tag, or folder name.</p>
        </div>
      )}
    </section>
  );
}

export function NoteReader({ note, notes, onSelect }: { note: MemoryNote; notes: MemoryNote[]; onSelect: (noteId: string) => void }) {
  return (
    <article className="flex min-w-0 flex-col overflow-hidden border border-border bg-card xl:absolute xl:inset-0" aria-labelledby="reader-title">
      <header className="flex min-h-[5.75rem] flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border p-5">
        <div className="min-w-0">
          <h2 id="reader-title" className="text-balance text-[1.25rem] font-normal leading-tight tracking-[-0.02em]">{note.title}</h2>
          <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">{note.path}</p>
        </div>
        <div className="flex min-w-0 flex-col items-start gap-2 sm:items-end">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.04em] text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{note.updatedAt ? `Updated ${formatDate(note.updatedAt)}` : "No stored timestamp"}</span>
          <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <span className={`border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${kindStyles[note.kind].className}`}>{kindStyles[note.kind].label}</span>
            {note.network ? <span className="border border-border-strong px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">{note.network}</span> : null}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 sm:p-6" tabIndex={0} role="region" aria-label={`${note.title} note body`}>
        {note.summary ? <p className="text-sm font-medium leading-6 text-foreground/90">{note.summary}</p> : <p className="text-sm text-muted-foreground">This note has no stored body.</p>}
        {note.body.map((paragraph) => (
          <p key={paragraph} className="text-sm leading-7 text-muted-foreground">{paragraph}</p>
        ))}

        <div className="border-t border-border pt-5">
          <div className="label-mono flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Linked notes
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {note.links.map((linkId) => {
              const linked = notes.find((candidate) => candidate.id === linkId);
              if (!linked) return null;
              return (
                <button
                  key={linkId}
                  type="button"
                  onClick={() => onSelect(linkId)}
                  className="bracket bracket-hover bracket-light max-w-full truncate border border-border-strong bg-white/[0.03] px-2.5 py-1.5 font-mono text-[11px] text-foreground transition hover:bg-white/[0.06] pointer-coarse:min-h-11 pointer-coarse:py-2.5"
                >
                  [[{linked.title}]]
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Pinned to the bottom so it lines up with the graph's wikilinks label. */}
      <footer className="flex flex-wrap gap-2 border-t border-border px-5 pb-5 pt-4" aria-label="Note tags">
        {note.tags.map((tag) => (
          <span key={tag} className="inline-flex h-7 items-center gap-1 border border-border px-2 font-mono text-[11px] text-muted-foreground">
            <Tag className="h-3 w-3" aria-hidden="true" />#{tag}
          </span>
        ))}
      </footer>
    </article>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
