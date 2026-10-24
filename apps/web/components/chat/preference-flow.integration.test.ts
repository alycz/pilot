import { describe, expect, it, vi } from "vitest";

import {
  acceptPreferenceProposal,
  rejectPreferenceProposal,
} from "./preference-card";
import {
  parsePilotStreamLine,
  type PreferenceProposalEvent,
} from "./stream-parts";

describe("preference proposal stream-to-persistence flow", () => {
  it("leaves Profile unchanged on render/reject and persists only after accept", async () => {
    const profile = { preferences: [] as string[] };
    let streamed: PreferenceProposalEvent | undefined;
    const onPreference = vi.fn((proposal: PreferenceProposalEvent) => {
      streamed = proposal;
    });
    parsePilotStreamLine(
      `data: ${JSON.stringify({
        type: "data-preference",
        data: {
          id: "pref-integration",
          state: "proposed",
          preference: "Prefer AMM routes",
          reason: "The user explicitly asked for AMM-first routing",
          at: "2026-10-18T00:00:00.000Z",
        },
      })}`,
      { onText: vi.fn(), onCard: vi.fn(), onPreference },
    );

    expect(streamed).toBeDefined();
    expect(profile.preferences).toEqual([]);

    const persist = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        accepted?: unknown;
        preference?: unknown;
      };
      if (body.accepted === true && typeof body.preference === "string") {
        profile.preferences.push(body.preference);
      }
      return Response.json({ ok: true, data: { profile } });
    });

    expect(rejectPreferenceProposal()).toBe("rejected");
    expect(persist).not.toHaveBeenCalled();
    expect(profile.preferences).toEqual([]);

    await acceptPreferenceProposal(streamed!, persist);
    expect(persist).toHaveBeenCalledOnce();
    expect(profile.preferences).toEqual(["Prefer AMM routes"]);
  });

  it("does not mutate Profile when persistence fails", async () => {
    const profile = { preferences: [] as string[] };
    const proposal: PreferenceProposalEvent = {
      id: "pref-failed",
      state: "proposed",
      preference: "Prefer order books",
      at: "2026-10-18T00:00:00.000Z",
    };
    const persist = vi.fn(async () => Response.json(
      { ok: false, error: { message: "Profile write failed" } },
      { status: 500 },
    ));

    await expect(acceptPreferenceProposal(proposal, persist)).rejects.toThrow("Profile write failed");
    expect(profile.preferences).toEqual([]);
  });
});
