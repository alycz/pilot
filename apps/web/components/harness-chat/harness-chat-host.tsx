"use client";

import { MessageCircle, PanelLeftClose, X } from "lucide-react";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { ChatView } from "../chat";
import {
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
} from "../../lib/harbor-browser";

import { HarnessPageContextProvider } from "./page-context-provider";
import {
  harnessChatPresentation,
  harnessChatUsesAppShell,
} from "./harness-chat-state";
import {
  ConversationSessionController,
  type ConversationSession,
} from "./conversation-session";
import { HarnessWalletSessionProvider } from "./session-context";

const PANEL_ID = "pilot-harness-chat-panel";
const DESKTOP_QUERY = "(min-width: 1024px)";

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return desktop;
}

function useConversationSession(enabled: boolean): ConversationSession | undefined {
  const [resolved, setResolved] = useState<ConversationSession>();

  useEffect(() => {
    if (!enabled) return;
    const controller = new ConversationSessionController(
      (signal) => loadWalletSessionStatus(globalThis.fetch, signal),
      setResolved,
    );
    const refresh = () => controller.refresh();
    const refreshAfterSessionChange = () => controller.refreshAfterSessionChange();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener(WALLET_SESSION_CHANGED_EVENT, refreshAfterSessionChange);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    return () => {
      controller.dispose();
      window.clearInterval(interval);
      window.removeEventListener(WALLET_SESSION_CHANGED_EVENT, refreshAfterSessionChange);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled]);

  return resolved;
}

export function HarnessChatHost({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const desktop = useDesktopViewport();
  const [requestedOpen, setRequestedOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const wasDrawerOpen = useRef(false);
  const presentation = harnessChatPresentation(pathname, requestedOpen, desktop);
  const usesAppShell = harnessChatUsesAppShell(pathname);
  const [sessionActivated, setSessionActivated] = useState(
    () => usesAppShell || presentation.fullPage || presentation.open,
  );
  const shouldResolveSession =
    sessionActivated || usesAppShell || presentation.fullPage || presentation.open;
  const conversationSession = useConversationSession(shouldResolveSession);

  useEffect(() => {
    if (usesAppShell || presentation.fullPage || presentation.open) {
      setSessionActivated(true);
    }
  }, [presentation.fullPage, presentation.open, usesAppShell]);

  const closeDrawer = useCallback(() => {
    if (presentation.fullPage) return;
    setRequestedOpen(false);
  }, [presentation.fullPage]);

  useEffect(() => {
    if (presentation.fullPage || presentation.hidden) return;
    if (presentation.open) {
      wasDrawerOpen.current = true;
      const frame = window.requestAnimationFrame(() =>
        closeRef.current?.focus({ preventScroll: true }),
      );
      // Chromium can restore pointer focus to the opener while the sliding
      // dialog is still settling. Reassert only if focus is still on the
      // opener/page, never after the user has moved into the conversation.
      const settled = window.setTimeout(() => {
        const active = document.activeElement;
        if (
          active === openerRef.current ||
          active === document.body ||
          active === document.documentElement
        ) {
          closeRef.current?.focus({ preventScroll: true });
        }
      }, 200);
      return () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(settled);
      };
    } else if (wasDrawerOpen.current) {
      wasDrawerOpen.current = false;
      const frame = window.requestAnimationFrame(() => openerRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [presentation.fullPage, presentation.hidden, presentation.open]);

  useEffect(() => {
    if (!presentation.open || presentation.fullPage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panelRef.current?.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      closeDrawer();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, presentation.fullPage, presentation.open]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    page.inert = presentation.modal;
    const previousOverflow = document.body.style.overflow;
    if (presentation.modal) document.body.style.overflow = "hidden";
    return () => {
      page.inert = false;
      document.body.style.overflow = previousOverflow;
    };
  }, [presentation.modal]);

  const onPanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !presentation.fullPage) {
      if (panelRef.current?.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab" || !presentation.modal || !panelRef.current) return;
    const focusable = focusableElements(panelRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [closeDrawer, presentation.fullPage, presentation.modal]);

  return (
    <HarnessPageContextProvider pathname={pathname}>
      <div className={usesAppShell ? "harness-chat-host--app-shell" : "harness-chat-host--standalone"}>
        <div ref={pageRef}>{children}</div>

        {!presentation.fullPage && !presentation.hidden ? (
        <button
          ref={openerRef}
          type="button"
          data-testid="harness-chat-toggle"
          aria-controls={PANEL_ID}
          aria-expanded={presentation.open}
          aria-label={presentation.open ? "Minimize workspace chat" : "Open workspace chat"}
          onClick={() => setRequestedOpen((open) => !open)}
          className={`harness-chat-toggle ${presentation.open ? "harness-chat-toggle--open" : ""}`}
        >
          {presentation.open ? <PanelLeftClose aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
          <span>Harness</span>
        </button>
        ) : null}

        {presentation.modal ? (
        <button
          type="button"
          data-testid="harness-chat-backdrop"
          aria-label="Close workspace chat"
          className="harness-chat-backdrop"
          onClick={closeDrawer}
        />
        ) : null}

        <section
        ref={panelRef}
        id={PANEL_ID}
        data-testid="harness-chat-panel"
        role={presentation.role}
        aria-label="Workspace chat"
        aria-modal={presentation.modal || undefined}
        aria-hidden={!presentation.open}
        inert={presentation.open ? undefined : true}
        onKeyDown={onPanelKeyDown}
        className={`harness-chat-panel ${presentation.fullPage ? "harness-chat-panel--full" : "harness-chat-panel--drawer"} ${presentation.open ? "harness-chat-panel--open" : "harness-chat-panel--closed"}`}
      >
        {!presentation.fullPage ? (
          <header className="harness-chat-header">
            <div>
              <p className="label-mono">Same conversation · every page</p>
              <h2>Workspace chat</h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              aria-label="Minimize workspace chat"
              onClick={closeDrawer}
              className="harness-chat-close"
            >
              <X aria-hidden="true" />
            </button>
          </header>
        ) : null}

        <div className="harness-chat-view">
          {!shouldResolveSession ? (
            <div className="harness-chat-loading">Open the harness to start a conversation.</div>
          ) : conversationSession === undefined ? (
            <div className="harness-chat-loading" role="status">Checking workspace session…</div>
          ) : (
            <HarnessWalletSessionProvider session={conversationSession.session}>
              <ChatView key={conversationSession.scope} />
            </HarnessWalletSessionProvider>
          )}
        </div>
        </section>
      </div>
    </HarnessPageContextProvider>
  );
}
