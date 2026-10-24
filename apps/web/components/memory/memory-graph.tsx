"use client";

import { Network, Waypoints } from "lucide-react";

import type { MemoryGraphEdge, MemoryGraphNode } from "./types";

// Token-driven node colors so the graph follows the theme (incl. a future light theme).
const nodeColor = {
  profile: "var(--chart-4)",
  policy: "var(--approval)",
  journal: "var(--info)",
  trade: "var(--executed)",
  venue: "var(--foreground)",
  token: "var(--muted-foreground)",
  reflection: "var(--chart-4)",
} as const;

export function MemoryGraph({
  nodes,
  edges,
  selectedNoteId,
  onSelect,
}: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  selectedNoteId: string;
  onSelect: (noteId: string) => void;
}) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return (
    <section className="min-w-0 overflow-hidden border border-border bg-card rounded-xl" aria-labelledby="graph-title">
      <header className="flex min-h-[5.75rem] items-center justify-between gap-4 border-b border-border p-5">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h2 id="graph-title" className="text-[1.25rem] font-normal leading-tight tracking-[-0.02em]">Knowledge graph</h2>
          </div>
          <p className="label-mono mt-1.5">Select a node to open its source note.</p>
        </div>
        <span className="shrink-0 border border-border px-2 py-1 text-[13px] text-muted-foreground rounded-xl">{nodes.length} nodes · {edges.length} links</span>
      </header>

      <div className="relative p-3 sm:p-5">
        <svg viewBox="0 0 500 360" className="relative h-[18rem] w-full sm:h-[22rem]" role="group" aria-labelledby="graph-svg-title graph-svg-desc">
          <title id="graph-svg-title">Pilot memory note relationships</title>
          <desc id="graph-svg-desc">A graph linking the profile, policy, journal, recent trade, reflection, venue, and token notes.</desc>
          <g style={{ stroke: "var(--border-strong)" }} strokeWidth="1">
            {edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              return from && to ? <line key={`${edge.from}-${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} /> : null;
            })}
          </g>
          {nodes.map((node) => {
            const selected = node.noteId === selectedNoteId;
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${node.label} note`}
                aria-pressed={selected}
                onClick={() => onSelect(node.noteId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(node.noteId);
                  }
                }}
                className="group cursor-pointer outline-none"
              >
{/* Invisible 64-unit hit area (≥44px even when the graph scales down on phones) (plus the label) so nodes are easy to tap. */}
                <rect x={node.x - 36} y={node.y - 26} width={72} height={70} fill="transparent" aria-hidden="true" />
                <NodeMark x={node.x} y={node.y} color={nodeColor[node.kind]} selected={selected} />
                <text
                  x={node.x}
                  y={node.y + 34}
                  textAnchor="middle"
                  fontSize="11"
                  letterSpacing="0.4"
                  style={{ fill: selected ? "var(--foreground)" : "var(--muted-foreground)", fontFamily: "var(--font-mono)", textTransform: "uppercase" }}
                  fontWeight={selected ? 600 : 500}
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute bottom-3 left-3 flex h-7 items-center gap-1.5 border border-border bg-background/80 px-2 text-xs text-muted-foreground sm:bottom-5 sm:left-5 rounded-md">
          <Waypoints className="h-3 w-3" aria-hidden="true" /> Obsidian-compatible wikilinks
        </div>
      </div>
    </section>
  );
}

/** Square node with crop-mark corners when selected; the outer frame only shows on keyboard focus. */
function NodeMark({ x, y, color, selected }: { x: number; y: number; color: string; selected: boolean }) {
  const half = selected ? 15 : 12;
  const arm = 5;
  const ring = half + 6;
  const corners: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  return (
    <>
      <rect
        x={x - ring}
        y={y - ring}
        width={ring * 2}
        height={ring * 2}
        fill="none"
        strokeWidth="1"
        style={{ stroke: "var(--ring)" }}
        className="opacity-0 transition-opacity group-focus-visible:opacity-100"
        aria-hidden="true"
      />
      <rect
        x={x - half}
        y={y - half}
        width={half * 2}
        height={half * 2}
        strokeWidth="1"
        style={{ fill: color, fillOpacity: selected ? 0.16 : 0.07, stroke: color, strokeOpacity: selected ? 0.9 : 0.55 }}
      />
      {selected
        ? corners.map(([dx, dy]) => (
            <path
              key={`${dx}${dy}`}
              d={`M ${x + dx * (half + 4)} ${y + dy * (half + 4 - arm)} V ${y + dy * (half + 4)} H ${x + dx * (half + 4 - arm)}`}
              fill="none"
              strokeWidth="1.25"
              style={{ stroke: "var(--bracket)" }}
              aria-hidden="true"
            />
          ))
        : null}
      <rect x={x - 2.5} y={y - 2.5} width="5" height="5" style={{ fill: color }} />
    </>
  );
}
