import React from "react";

import { DOCS_PATH } from "../../lib/docs-origin";

/**
 * Link to the docs site. A plain anchor, not next/link: /docs is a separately
 * deployed site mounted by rewrite, so it needs a full document load.
 */
export function DocsLink({ className = "inline-flex" }: { className?: string }) {
  // Display utilities come only from className, so "hidden lg:inline-flex" works.
  return (
    <a
      href={DOCS_PATH}
      className={`min-h-11 items-center px-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground ${className}`}
    >
      Docs
    </a>
  );
}
