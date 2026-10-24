import type { WalletSessionStatus } from "../../lib/harbor-browser";

export type WalletSessionRefreshState = WalletSessionStatus | null | undefined;

export function observeWalletSessionChanges({
  eventName,
  load,
  onChange,
  target,
}: {
  eventName: string;
  load: () => Promise<WalletSessionStatus>;
  onChange: (state: WalletSessionRefreshState) => void;
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}): () => void {
  let active = true;
  let generation = 0;

  const refresh = () => {
    const requestGeneration = ++generation;
    onChange(undefined);
    void load()
      .then((session) => {
        if (active && requestGeneration === generation) onChange(session);
      })
      .catch(() => {
        if (active && requestGeneration === generation) onChange(null);
      });
  };

  target.addEventListener(eventName, refresh);
  refresh();
  return () => {
    active = false;
    generation += 1;
    target.removeEventListener(eventName, refresh);
  };
}
