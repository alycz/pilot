import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AppShell,
  demoSwitchRevocationNotice,
  persistModelSelection,
} from "./app-shell";

describe("AppShell navigation", () => {
  it("links to the interactive system explainer from desktop and mobile navigation", () => {
    const markup = renderToStaticMarkup(
      <AppShell title="Pilot"><div>Content</div></AppShell>,
    );

    expect(markup.match(/href="\/how-it-works"/g)).toHaveLength(2);
    expect(markup.match(/>How it works</g)).toHaveLength(2);
  });

  it("links to autonomous strategy controls from desktop and mobile navigation", () => {
    const markup = renderToStaticMarkup(
      <AppShell active="strategy" title="Autonomous strategy"><div>Content</div></AppShell>,
    );

    expect(markup.match(/href="\/strategy"/g)).toHaveLength(2);
    expect(markup.match(/>Strategy</g)).toHaveLength(2);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(2);
  });
});

describe("model settings persistence", () => {
  it("warns about provider revocation only when leaving OAuth", () => {
    expect(demoSwitchRevocationNotice("oauth")).toMatch(/remains active.*revoke/i);
    expect(demoSwitchRevocationNotice("demo")).toBeUndefined();
  });

  it("rejects an unavailable demo switch before the UI can commit local state", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: "The free demo is not configured." },
      { status: 503 },
    ));

    await expect(persistModelSelection(
      fetcher as typeof fetch,
      "provider/free:free",
      "demo",
    )).rejects.toThrow("The free demo is not configured.");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/openrouter/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free:free" }),
      }),
    );
  });
});
