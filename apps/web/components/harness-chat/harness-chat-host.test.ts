import { describe, expect, it } from "vitest";

import {
  harnessChatUsesAppShell,
  harnessChatPresentation,
  walletConversationScope,
  walletSessionExpiryDelay,
} from "./harness-chat-state";

describe("harnessChatPresentation", () => {
  it("uses the single persistent surface as the full chat route", () => {
    expect(harnessChatPresentation("/chat", false, true)).toEqual({
      fullPage: true,
      hidden: false,
      open: true,
      modal: false,
      role: "region",
    });
  });

  it("uses a non-modal desktop drawer and a modal mobile overlay", () => {
    expect(harnessChatPresentation("/portfolio", true, true)).toMatchObject({
      open: true,
      modal: false,
      role: "region",
    });
    expect(harnessChatPresentation("/portfolio", true, false)).toMatchObject({
      open: true,
      modal: true,
      role: "dialog",
    });
  });

  it("never exposes the harness over the OpenRouter callback", () => {
    expect(harnessChatPresentation("/openrouter/finalize", true, false)).toMatchObject({
      hidden: true,
      open: false,
      modal: false,
    });
  });
});

describe("walletConversationScope", () => {
  it("isolates authenticated conversations by exact account and network", () => {
    expect(walletConversationScope({
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
    })).toBe("testnet:r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59");
    expect(walletConversationScope({
      authenticated: true,
      account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      network: "devnet",
    })).toBe("devnet:rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe");
  });

  it("uses one honest signed-out scope with no fabricated account", () => {
    expect(walletConversationScope({ authenticated: false })).toBe("signed-out");
    expect(walletConversationScope(null)).toBe("signed-out");
  });

  it("expires the account scope at the declared session boundary", () => {
    const session = {
      authenticated: true as const,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet" as const,
      expiresAt: 10_000,
    };
    expect(walletConversationScope(session, 9_999)).toContain(session.account);
    expect(walletConversationScope(session, 10_000)).toBe("signed-out");
    expect(walletSessionExpiryDelay(session, 9_250)).toBe(750);
  });
});

describe("harnessChatUsesAppShell", () => {
  it("applies the desktop sidebar offset only to AppShell routes", () => {
    expect(harnessChatUsesAppShell("/portfolio")).toBe(true);
    expect(harnessChatUsesAppShell("/chat")).toBe(true);
    expect(harnessChatUsesAppShell("/agreements")).toBe(true);
    expect(harnessChatUsesAppShell("/research/backtests")).toBe(true);
    expect(harnessChatUsesAppShell("/strategy-research")).toBe(true);
    expect(harnessChatUsesAppShell("/")).toBe(false);
    expect(harnessChatUsesAppShell("/onboarding")).toBe(false);
  });
});
