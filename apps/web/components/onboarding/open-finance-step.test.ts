import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const componentPath = fileURLToPath(new URL("./open-finance-step.tsx", import.meta.url));

describe("Open Finance onboarding step", () => {
  it("contains the required label, budget rule, and server-only privacy copy", async () => {
    const source = await readFile(componentPath, "utf8");
    expect(source).toContain("Mastercard Open Finance · mock");
    expect(source).toContain("Verified owner ·");
    expect(source).toContain("floor(2% of checking balance)");
    expect(source).toContain("Raw owner");
    expect(source).toContain("customer_ref_hash: string");
    expect(source).not.toMatch(/\bcustomer_ref:\s*string/);
  });
});
