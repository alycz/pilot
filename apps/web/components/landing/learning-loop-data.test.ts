import { describe, expect, it } from "vitest";

import { loopLinks, loopNodes, loopScenes } from "./learning-loop-data";

const ids = new Set(loopNodes.map((node) => node.id));
const links = new Set(loopLinks.map(([a, b]) => [a, b].sort().join("|")));

describe("learning loop script", () => {
  it.each(["approval", "auto", "blocked"] as const)("the %s story only travels along drawn links", (branch) => {
    for (const scene of loopScenes(branch)) {
      for (const node of scene.route) expect(ids.has(node)).toBe(true);
      scene.route.slice(1).forEach((node, step) => {
        expect(links.has([scene.route[step]!, node].sort().join("|"))).toBe(true);
      });
    }
  });

  it("keeps the limits check at the same step in every story", () => {
    for (const branch of ["approval", "auto", "blocked"] as const) {
      expect(loopScenes(branch)[5]?.id).toBe("policy");
    }
  });

  it("only reaches the ledger and records notes when the trade isn't blocked", () => {
    expect(loopScenes("blocked").map((scene) => scene.id)).not.toContain("ledger");
    expect(loopScenes("blocked").map((scene) => scene.id)).not.toContain("record");
    expect(loopScenes("approval").map((scene) => scene.id)).toEqual(expect.arrayContaining(["sign", "ledger", "record"]));
    expect(loopScenes("auto").map((scene) => scene.id)).toEqual(expect.arrayContaining(["auto", "ledger", "record"]));
  });

  it("ends every story with learning, review and the next turn", () => {
    for (const branch of ["approval", "auto", "blocked"] as const) {
      expect(loopScenes(branch).slice(-3).map((scene) => scene.id)).toEqual(["learn", "review", "next"]);
    }
  });
});
