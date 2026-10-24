import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { integrationLinks } from "../integrations/integration-links";
import { IntegrationsMenu } from "../integrations/integrations-menu";

describe("landing integrations navigation", () => {
  it("exposes an accessible dropdown trigger", () => {
    const markup = renderToStaticMarkup(createElement(IntegrationsMenu));
    expect(markup).toContain("Integrations");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain("aria-controls=");
  });

  it("contains four stable shareable destinations", () => {
    expect(integrationLinks).toHaveLength(4);
    for (const link of integrationLinks) {
      expect(link.href).toMatch(/^\/integrations\/[a-z-]+$/);
      expect(link.label.length).toBeGreaterThan(2);
      expect(link.detail.length).toBeGreaterThan(2);
    }
  });

  it("wires the dropdown and mobile links into the real landing navigation", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./landing-nav.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("<IntegrationsMenu");
    expect(source).toContain("integrationLinks.map");
    expect(source).toContain('aria-controls="landing-mobile-menu"');
  });
});
