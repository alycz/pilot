import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256CanonicalJson, sha256Hex } from "./sha256-sync";

describe("browser-safe SHA-256", () => {
  it.each(["", "abc", "Pilot · synthetic XRP/RLUSD fixture"])("matches Node crypto for %j", (value) => {
    expect(sha256Hex(value)).toBe(createHash("sha256").update(value, "utf8").digest("hex"));
  });

  it("sorts object keys before hashing and matches Node crypto", () => {
    const input = { z: [3, 2, 1], a: { beta: true, alpha: "fixture" } };
    const canonical = canonicalJson(input);
    expect(sha256CanonicalJson(input)).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
  });
});
