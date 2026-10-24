import { readFile } from "node:fs/promises";
import path from "node:path";

import { PolicySchema, ProfileSchema } from "@pilot/contracts";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

const templateRoot = path.resolve(process.cwd(), "../../vault-template/Pilot");

describe("vault template", () => {
  it("contains valid Profile and Policy contract frontmatter", async () => {
    const [profile, policy] = await Promise.all([
      readFile(path.join(templateRoot, "Profile.md"), "utf8"),
      readFile(path.join(templateRoot, "Policy.md"), "utf8"),
    ]);
    expect(ProfileSchema.parse(matter(profile).data)).toMatchObject({
      network: "testnet",
      risk: "low",
      preferences: [],
    });
    expect(PolicySchema.parse(matter(policy).data)).toMatchObject({
      max_per_tx_usd: 2000,
      networks: ["testnet", "devnet"],
    });
  });

  it("links every required note collection from the Pilot home note", async () => {
    const home = await readFile(path.join(templateRoot, "README.md"), "utf8");
    for (const collection of ["Journal", "Trades", "Venues", "Tokens", "Reflections"]) {
      expect(home).toContain(`[[${collection}/README|${collection}]]`);
      await expect(readFile(path.join(templateRoot, collection, "README.md"), "utf8")).resolves.toContain(
        `collection: ${collection.toLowerCase()}`,
      );
    }
  });
});
