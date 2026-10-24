import type { WalletSessionStatus } from "../../lib/harbor-browser";

import {
  walletConversationScope,
  walletSessionExpiryDelay,
} from "./harness-chat-state";

export type ConversationSession = Readonly<{
  scope: string;
  session: WalletSessionStatus | null;
}>;

type SessionLoader = (signal: AbortSignal) => Promise<WalletSessionStatus | null>;
type SessionListener = (session: ConversationSession | undefined) => void;

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/**
 * Owns session request cancellation and the authenticated-session boundary.
 * A background refresh deliberately leaves the prior expiry timer armed until
 * a successful replacement has been accepted.
 */
export class ConversationSessionController {
  private generation = 0;
  private request: AbortController | undefined;
  private expiryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly load: SessionLoader,
    private readonly publish: SessionListener,
  ) {}

  refresh(): void {
    this.startRefresh(false);
  }

  refreshAfterSessionChange(): void {
    this.startRefresh(true);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.request?.abort();
    this.request = undefined;
    this.clearExpiryTimer();
  }

  private startRefresh(clearWhilePending: boolean): void {
    if (this.disposed) return;
    const current = ++this.generation;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    if (clearWhilePending) this.publish(undefined);

    void this.load(request.signal)
      .then((session) => {
        if (this.disposed || current !== this.generation) return;
        this.request = undefined;
        this.clearExpiryTimer();
        const acceptedAt = Date.now();
        const scope = walletConversationScope(session, acceptedAt);
        const expiryDelay = walletSessionExpiryDelay(session, acceptedAt);
        const activeSession = scope === "signed-out"
          ? { authenticated: false as const }
          : session;
        this.publish({ scope, session: activeSession });
        if (expiryDelay !== undefined && expiryDelay > 0) {
          const timer = globalThis.setTimeout(() => {
            if (this.disposed || this.expiryTimer !== timer) return;
            this.expiryTimer = undefined;
            // Expiry is a trust boundary: abort any in-flight background read,
            // unmount the account-keyed chat, then revalidate from signed out.
            this.generation += 1;
            this.request?.abort();
            this.request = undefined;
            this.publish({ scope: "signed-out", session: { authenticated: false } });
            this.refresh();
          }, expiryDelay);
          this.expiryTimer = timer;
        }
      })
      .catch((cause) => {
        if (this.disposed || current !== this.generation || isAbortError(cause)) return;
        this.request = undefined;
        this.clearExpiryTimer();
        this.publish({ scope: "unavailable", session: null });
      });
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    globalThis.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}
