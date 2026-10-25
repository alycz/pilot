import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("landing architecture partner line", () => {
  it("mentions QuickNode once inside the existing architecture section without adding a section", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./landing-page.tsx", import.meta.url)),
      "utf8",
    );
    const partnerLine = "QuickNode RPC, confirmation and key-monitoring contracts · provider calls default-off";

    expect(source.match(new RegExp(partnerLine, "g"))).toHaveLength(1);
    const architecture = source.slice(
      source.indexOf("function Architecture()"),
      source.indexOf("function UseCases()"),
    );
    expect(architecture).toContain(partnerLine);
    expect(architecture.match(/<Section\b/g)).toHaveLength(1);
  });

  it("keeps public readiness claims aligned with the mock and default-off runtime", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./landing-page.tsx", import.meta.url)),
      "utf8",
    );

    for (const staleClaim of [
      "Live on Testnet today",
      "Live end-to-end trades in the Pilot app",
      "Pilot is live on Testnet",
      "Pilot developer APIs · Live on XRPL Testnet",
      "Ledger, QuickNode, AWS and Mastercard integrations",
    ]) {
      expect(source).not.toContain(staleClaim);
    }

    expect(source).toContain("Public runtime: explicit mock/default-off");
    expect(source).toContain("The current public runtime makes no provider calls or transactions.");
    expect(source).toContain("Ledger, QuickNode, AWS and Mastercard adapters are default-off");
    expect(source).toContain("Testnet fixture");
  });
});
