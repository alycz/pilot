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
  private published = false;
  private provisionalTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  /**
   * `provisionalDelayMs`: when the very first session check takes longer than
   * this, show the signed-out (demo) conversation instead of a loading screen.
   * Signed out grants nothing, and the real answer still replaces it when it
   * arrives.
   */
  constructor(
    private readonly load: SessionLoader,
    private readonly publishSession: SessionListener,
    private readonly provisionalDelayMs?: number,
  ) {}

  private publish(session: ConversationSession | undefined): void {
    if (session !== undefined) this.published = true;
    this.publishSession(session);
  }

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
    this.clearProvisionalTimer();
  }

  private clearProvisionalTimer(): void {
    if (this.provisionalTimer === undefined) return;
    globalThis.clearTimeout(this.provisionalTimer);
    this.provisionalTimer = undefined;
  }

  private startRefresh(clearWhilePending: boolean): void {
    if (this.disposed) return;
    const current = ++this.generation;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    if (clearWhilePending) {
      this.published = false;
      this.publish(undefined);
    }
    if (!this.published && this.provisionalDelayMs !== undefined && this.provisionalTimer === undefined) {
      this.provisionalTimer = globalThis.setTimeout(() => {
        this.provisionalTimer = undefined;
        if (this.disposed || this.published) return;
        this.publish({ scope: "signed-out", session: { authenticated: false } });
      }, this.provisionalDelayMs);
    }

    void this.load(request.signal)
      .then((session) => {
        if (this.disposed || current !== this.generation) return;
        this.request = undefined;
        this.clearExpiryTimer();
        this.clearProvisionalTimer();
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
        this.clearProvisionalTimer();
        this.publish({ scope: "unavailable", session: null });
      });
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    globalThis.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}
