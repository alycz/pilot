import { describe, expect, it, vi } from "vitest";

import type { HarborClient } from "@pilot/harbor-client";
import { loadLiveNearIntentsTokens } from "./near-live-preview";

describe("live NEAR Intents preview boundary", () => {
  it("accepts only explicitly live token inventory", async () => {
    const client = { op: vi.fn(async () => ({
      ok: true,
      data: { provider: "near-intents-1click", source: "live", live: true, execution_enabled: false, count: 0, tokens: [] },
      asOf: "2026-10-26T00:00:00.000Z",
      asOfBasis: "provider",
    })) } as unknown as Pick<HarborClient, "op">;
    await expect(loadLiveNearIntentsTokens(client)).resolves.toMatchObject({ source: "live", execution_enabled: false });
  });

  it("never silently substitutes fixture inventory", async () => {
    const client = { op: vi.fn(async () => ({
      ok: true,
      data: { provider: "near-intents-1click", source: "fixture", live: false, execution_enabled: false, count: 0, tokens: [] },
      asOf: "2026-10-26T00:00:00.000Z",
      asOfBasis: "fixture",
    })) } as unknown as Pick<HarborClient, "op">;
    await expect(loadLiveNearIntentsTokens(client)).rejects.toThrow(/fixture data/);
  });
});
