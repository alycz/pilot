import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOSTED_SPECULOS_PROVENANCE,
  HostedSpeculosCompanion,
} from "./hosted-speculos-companion";

const previous = process.env.NEXT_PUBLIC_LEDGER_COMPANION_ENABLED;

afterEach(() => {
  if (previous === undefined) delete process.env.NEXT_PUBLIC_LEDGER_COMPANION_ENABLED;
  else process.env.NEXT_PUBLIC_LEDGER_COMPANION_ENABLED = previous;
});

describe("HostedSpeculosCompanion", () => {
  it("renders honest emulator provenance and remains default-off", () => {
    delete process.env.NEXT_PUBLIC_LEDGER_COMPANION_ENABLED;
    const html = renderToStaticMarkup(<HostedSpeculosCompanion />);
    expect(html).toContain(HOSTED_SPECULOS_PROVENANCE);
    expect(html).toContain("does not prove a physical Ledger or settlement");
    expect(html).toContain("Hosted companion signing is disabled in this build");
    expect(html).toContain("Pair exact fixture");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Pair exact fixture<\/button>/);
    expect(html).not.toContain("seed=");
  });
});
