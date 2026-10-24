import type { WalletSessionStatus } from "../../lib/harbor-browser";

// The landing page has its own calls to action, so the Ask Pilot button stays off it.
const HIDDEN_ROUTES = new Set(["/", "/onboarding", "/openrouter/finalize"]);
const APP_SHELL_ROUTES = new Set([
  "/agreements",
  "/chat",
  "/map",
  "/markets",
  "/memory",
  "/portfolio",
  "/research/backtests",
  "/strategy",
  "/strategy-research",
]);

export type HarnessChatPresentation = Readonly<{
  fullPage: boolean;
  hidden: boolean;
  open: boolean;
  modal: boolean;
  role: "dialog" | "region";
}>;

export function harnessChatPresentation(
  pathname: string,
  requestedOpen: boolean,
  desktop: boolean,
): HarnessChatPresentation {
  const fullPage = pathname === "/chat";
  const hidden = HIDDEN_ROUTES.has(pathname);
  const open = !hidden && (fullPage || requestedOpen);
  const modal = open && !fullPage && !desktop;
  return {
    fullPage,
    hidden,
    open,
    modal,
    role: modal ? "dialog" : "region",
  };
}

export function harnessChatUsesAppShell(pathname: string): boolean {
  return APP_SHELL_ROUTES.has(pathname) || /^\/markets\/[a-z0-9-]+$/.test(pathname);
}

export function walletSessionExpiryDelay(
  session: WalletSessionStatus | null,
  now = Date.now(),
): number | undefined {
  if (!session?.authenticated || session.expiresAt === undefined) return undefined;
  return Math.max(0, Math.min(2_147_483_647, session.expiresAt - now));
}

export function walletConversationScope(
  session: WalletSessionStatus | null,
  now = Date.now(),
): string {
  if (!session?.authenticated || (session.expiresAt !== undefined && session.expiresAt <= now)) {
    return "signed-out";
  }
  return `${session.network}:${session.account}`;
}
