"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  resolveHarnessPageContext,
  type HarnessPageContext,
} from "./page-context";

type PageSummary = Readonly<Record<string, unknown>>;

function summarySignature(summary: PageSummary): string {
  return JSON.stringify(Object.keys(summary).sort().flatMap((key) => {
    const value = summary[key];
    return typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
      ? [[key, typeof value, value]]
      : [];
  }));
}

type HarnessPageContextValue = Readonly<{
  context?: HarnessPageContext;
  publishSummary(summary: PageSummary): void;
}>;

const HarnessPageContextState = createContext<HarnessPageContextValue>({
  context: undefined,
  publishSummary: () => undefined,
});

export function HarnessPageContextProvider({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const [published, setPublished] = useState<{
    pathname: string;
    summary: PageSummary;
  }>({ pathname, summary: {} });

  const publishSummary = useCallback((summary: PageSummary) => {
    setPublished({ pathname, summary });
  }, [pathname]);

  const context = useMemo(() => resolveHarnessPageContext(
    pathname,
    published.pathname === pathname ? published.summary : {},
  ), [pathname, published]);

  const value = useMemo<HarnessPageContextValue>(() => ({
    context,
    publishSummary,
  }), [context, publishSummary]);

  return (
    <HarnessPageContextState.Provider value={value}>
      {children}
    </HarnessPageContextState.Provider>
  );
}

/** Returns the immutable, allowlisted context snapshot for the next chat request. */
export function useHarnessPageContext(): HarnessPageContext | undefined {
  return useContext(HarnessPageContextState).context;
}

/**
 * Lets a page publish a small explicit summary. The route-specific sanitizer is
 * still authoritative; publishing never grants execution authority.
 */
export function usePublishHarnessPageSummary(summary: PageSummary): void {
  const { publishSummary } = useContext(HarnessPageContextState);
  const signature = summarySignature(summary);
  const stableSummary = useMemo(() => summary, [signature]);
  useEffect(() => {
    publishSummary(stableSummary);
    return () => publishSummary({});
  }, [publishSummary, stableSummary]);
}
