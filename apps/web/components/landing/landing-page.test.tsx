import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("landing architecture partner line", () => {
  it("mentions QuickNode once inside the existing architecture section without adding a section", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./landing-page.tsx", import.meta.url)),
      "utf8",
    );
    const partnerLine = "RPC, confirmations and agent-key monitoring on QuickNode";

    expect(source.match(new RegExp(partnerLine, "g"))).toHaveLength(1);
    const architecture = source.slice(
      source.indexOf("function Architecture()"),
      source.indexOf("function UseCases()"),
    );
    expect(architecture).toContain(partnerLine);
    expect(architecture.match(/<Section\b/g)).toHaveLength(1);
  });
});
