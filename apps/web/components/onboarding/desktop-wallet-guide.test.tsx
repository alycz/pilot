import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CROSSMARK_SETUP_URL,
  DesktopWalletGuide,
  GEMWALLET_SETUP_URL,
} from "./desktop-wallet-guide";

function renderGuide(): string {
  return renderToStaticMarkup(createElement(DesktopWalletGuide));
}

describe("DesktopWalletGuide", () => {
  it("presents GemWallet as the recommended desktop path and Crossmark as the alternative", () => {
    const markup = renderGuide();

    expect(markup).toContain("I already have a wallet");
    expect(markup).toContain("I need a wallet");
    expect(markup).toContain("GemWallet (recommended) or Crossmark");
    expect(markup).toContain("GemWallet setup · recommended");
    expect(markup).toContain("Crossmark setup · alternative");
    expect(markup.indexOf("GemWallet setup · recommended")).toBeLessThan(
      markup.indexOf("Crossmark setup · alternative"),
    );
  });

  it("links only to the official provider setup origins", () => {
    const markup = renderGuide();

    expect(new URL(GEMWALLET_SETUP_URL).origin).toBe("https://gemwallet.app");
    expect(new URL(CROSSMARK_SETUP_URL).origin).toBe("https://support.crossmark.io");
    expect(markup).toContain(`href="${GEMWALLET_SETUP_URL}"`);
    expect(markup).toContain(`href="${CROSSMARK_SETUP_URL}"`);
    expect(markup.match(/target="_blank"/g)).toHaveLength(2);
    expect(markup.match(/rel="noreferrer"/g)).toHaveLength(2);
  });

  it("keeps account setup inside the wallet and never renders a recovery-material input", () => {
    const markup = renderGuide();

    expect(markup).toContain("Pilot never asks for a seed phrase, recovery phrase, mnemonic, or private key");
    expect(markup).toContain("Account creation, import, and recovery stay inside the wallet extension");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
  });

  it("states the Testnet preflight and the mobile/Xaman limitation while preserving read-only access", () => {
    const markup = renderGuide();

    expect(markup).toContain("Switch the wallet to XRPL Testnet");
    expect(markup).toContain('aria-label="Mobile wallet availability"');
    expect(markup).toContain("Mobile wallet actions are not available yet");
    expect(markup).toContain("Xaman remains unavailable");
    expect(markup).toContain("non-broadcast wallet-auth proof");
    expect(markup).toContain('href="/chat"');
    expect(markup).toContain("Continue to read-only Pilot");
  });

  it("exposes structural labels for assistive technology", () => {
    const markup = renderGuide();

    expect(markup).toContain('aria-labelledby="desktop-wallet-guide-title"');
    expect(markup).toContain('id="desktop-wallet-guide-title"');
    expect(markup).toContain('role="note"');
  });
});
