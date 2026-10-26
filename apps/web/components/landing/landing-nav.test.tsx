import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { integrationLinks } from "../integrations/integration-links";
import { IntegrationsMenu } from "../integrations/integrations-menu";
import { DocsLink } from "./docs-link";

describe("landing integrations navigation", () => {
  it("exposes an accessible dropdown trigger", () => {
    const markup = renderToStaticMarkup(createElement(IntegrationsMenu));
    expect(markup).toContain("Integrations");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain("aria-controls=");
  });

  it("contains the stable integration explainers and bounded NEAR fixture destination", () => {
    expect(integrationLinks).toHaveLength(5);
    for (const link of integrationLinks) {
      expect(link.href).toMatch(/^\/(?:integrations|demo)\/[a-z-]+$/);
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

  it("links to the docs just before the integrations menu", () => {
    const markup = renderToStaticMarkup(createElement(DocsLink));
    expect(markup).toContain('href="/docs"');
    expect(markup).toContain(">Docs<");
    const source = readFileSync(
      fileURLToPath(new URL("./landing-nav.tsx", import.meta.url)),
      "utf8",
    );
    const docs = source.indexOf('<DocsLink className="hidden lg:inline-flex" />');
    const integrations = source.indexOf('<IntegrationsMenu current={current} className="hidden lg:block" />');
    expect(docs).toBeGreaterThan(-1);
    expect(docs).toBeLessThan(integrations);
  });
});
