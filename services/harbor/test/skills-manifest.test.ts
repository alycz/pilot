import { describe, expect, it } from "vitest";

import manifest from "../ecosystem-skills/MANIFEST.json";

const commit = "7e302d2781ae32be1b88485659e686e417f154c6";
const repositoryUrl = "https://github.com/XRPLF/xrpl-dev-portal";
const sourceRoot =
  `https://raw.githubusercontent.com/XRPLF/xrpl-dev-portal/${commit}` +
  "/.claude/skills/xrpl-skills";

const expectedSkills = [
  {
    id: "xrpl-agent-wallet",
    name: "XRPL Agent Wallet",
    repositoryUrl,
    documentationUrl: "https://xrpl.org/docs/agents/xrpl-agent-wallet-skill",
    commit,
    sourceUrl: `${sourceRoot}/xrpl-agent-wallet/SKILL.md`,
  },
  {
    id: "xrpl-payments",
    name: "XRPL Payments",
    repositoryUrl,
    documentationUrl: "https://xrpl.org/docs/agents/xrpl-payments-skill",
    commit,
    sourceUrl: `${sourceRoot}/xrpl-payments/SKILL.md`,
  },
  {
    id: "xrpl-trading",
    name: "XRPL Trading",
    repositoryUrl,
    documentationUrl: "https://xrpl.org/docs/agents/xrpl-trading-skill",
    commit,
    sourceUrl: `${sourceRoot}/xrpl-trading/SKILL.md`,
  },
] as const;

describe("pinned XRPL ecosystem skills", () => {
  it("contains exactly the three official skills at the researched revision", () => {
    expect(manifest).toEqual({ version: 1, skills: expectedSkills });
    expect(new Set(manifest.skills.map(({ id }) => id)).size).toBe(3);
  });

  it("uses fetchable raw-file URL shapes pinned to each recorded commit", () => {
    for (const skill of manifest.skills) {
      const source = new URL(skill.sourceUrl);
      const documentation = new URL(skill.documentationUrl);
      const sourceSegments = source.pathname.split("/").filter(Boolean);

      expect(source.protocol).toBe("https:");
      expect(source.hostname).toBe("raw.githubusercontent.com");
      expect(source.search).toBe("");
      expect(source.hash).toBe("");
      expect(sourceSegments.slice(0, 3)).toEqual([
        "XRPLF",
        "xrpl-dev-portal",
        skill.commit,
      ]);
      expect(skill.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(source.pathname).toBe(
        `/XRPLF/xrpl-dev-portal/${skill.commit}/.claude/skills/xrpl-skills/${skill.id}/SKILL.md`,
      );
      expect(source.pathname).not.toMatch(/\/(?:master|main)\//);

      expect(documentation.protocol).toBe("https:");
      expect(documentation.hostname).toBe("xrpl.org");
      expect(documentation.search).toBe("");
      expect(documentation.hash).toBe("");
    }
  });

  it("stores metadata only, without copied upstream skill content", () => {
    const allowedKeys = [
      "commit",
      "documentationUrl",
      "id",
      "name",
      "repositoryUrl",
      "sourceUrl",
    ];

    for (const skill of manifest.skills) {
      expect(Object.keys(skill).sort()).toEqual(allowedKeys);
    }
  });
});
