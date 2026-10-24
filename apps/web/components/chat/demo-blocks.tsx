import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import type { DemoBlock } from "./demo-script";

/** Renders structured parts of a scripted demo reply. */
export function DemoBlocks({ blocks }: { blocks: DemoBlock[] }) {
  return (
    <div className="mt-3 space-y-3">
      {blocks.map((block, index) => {
        if (block.kind === "table") {
          return (
            <div key={index} className="overflow-x-auto border border-border bg-card rounded-xl" tabIndex={0}>
              <table className="w-full min-w-[34rem] text-left text-xs">
                <caption className="label-mono border-b border-border px-3.5 py-2.5 text-left">{block.caption}</caption>
                <thead className="bg-white/[0.025]">
                  <tr>
                    {block.columns.map((column, columnIndex) => (
                      <th
                        key={column}
                        scope="col"
                        className={`label-mono px-3.5 py-2 font-medium ${block.numeric?.includes(columnIndex) ? "text-right" : ""}`}
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => {
                    const best = block.highlight === rowIndex;
                    return (
                      <tr key={row[0]} className={`border-t border-border ${best ? "bg-executed/[0.06]" : ""}`}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className={`px-3.5 py-2.5 ${cellIndex === 0 ? "text-foreground" : "font-mono tabular-nums text-foreground/90"} ${block.numeric?.includes(cellIndex) ? "text-right" : ""}`}
                          >
                            {cell}
                            {cellIndex === 0 && best ? (
                              <span className="ml-2 border border-executed/35 bg-executed/10 px-1 py-px text-xs text-executed rounded capitalize">Best</span>
                            ) : null}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === "stats") {
          return (
            <dl key={index} className="grid gap-px border border-border bg-border sm:grid-cols-3 rounded-xl overflow-hidden">
              {block.items.map((item) => (
                <div key={item.label} className="bg-card px-3.5 py-3">
                  <dt className="label-mono">{item.label}</dt>
                  <dd className="mt-1 font-mono text-[13px] tabular-nums text-foreground">{item.value}</dd>
                </div>
              ))}
            </dl>
          );
        }
        return (
          <Link
            key={index}
            href={block.href}
            className="link-dashed inline-flex items-center gap-1.5 text-[13px] text-foreground"
          >
            {block.label}
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}
