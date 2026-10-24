import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { isLedgerOwnerSigner, OwnerSignerChip } from "./owner-signer-chip";

describe("OwnerSignerChip", () => {
  it.each([
    ["webhid", "Signed via Ledger transport"],
    ["virtual", "Signed via Virtual Ledger (Speculos)"],
    [undefined, "Signed through configured Ledger flow"],
  ] as const)("renders bounded %s Ledger signing evidence", (transport, expected) => {
    const markup = renderToStaticMarkup(createElement(OwnerSignerChip, {
      signer: { kind: "ledger", accountIndex: 2, ...(transport ? { transport } : {}) },
    }));

    expect(markup).toContain(expected);
    expect(markup).toContain("account 2");
    expect(markup).toContain(`aria-label="Owner approval ${expected.toLowerCase()} account 2"`);
  });

  it.each([
    undefined,
    null,
    {},
    { kind: "software", accountIndex: 0 },
    { kind: "ledger", accountIndex: -1 },
    { kind: "ledger", accountIndex: 3 },
    { kind: "ledger", accountIndex: 1.5 },
    { kind: "ledger", accountIndex: 0, transport: "bluetooth" },
    { kind: "ledger", accountIndex: 0, raw: "untrusted" },
  ])("fails closed for non-canonical metadata %#", (signer) => {
    expect(isLedgerOwnerSigner(signer)).toBe(false);
    expect(renderToStaticMarkup(createElement(OwnerSignerChip, { signer: signer as never }))).toBe("");
  });
});
