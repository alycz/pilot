"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { WalletSessionStatus } from "../../lib/harbor-browser";

type HarnessWalletSessionValue = Readonly<{
  session: WalletSessionStatus | null;
}>;

const HarnessWalletSessionContext = createContext<HarnessWalletSessionValue | undefined>(undefined);

export function HarnessWalletSessionProvider({
  children,
  session,
}: {
  children: ReactNode;
  session: WalletSessionStatus | null;
}) {
  const value = useMemo(() => ({ session }), [session]);
  return (
    <HarnessWalletSessionContext.Provider value={value}>
      {children}
    </HarnessWalletSessionContext.Provider>
  );
}

export function useHarnessWalletSession(): HarnessWalletSessionValue | undefined {
  return useContext(HarnessWalletSessionContext);
}
