import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  acceptPreferenceProposal,
  canRejectPreference,
  canStartPreferenceAccept,
  PreferenceCard,
  PreferenceProposalConflictError,
  preferenceProposalRenderKey,
  refreshStructuredPreferenceProposal,
  rejectPreferenceProposal,
  rejectStructuredPreferenceProposal,
} from "./preference-card";
import type { PreferenceProposalEvent } from "./stream-parts";

const proposal: PreferenceProposalEvent = {
  id: "pref-1",
  state: "proposed",
  preference: "Prefer AMM routes",
  reason: "User explicitly asked for AMM-first routing",
  at: "2026-10-18T00:00:00.000Z",
};

describe("PreferenceCard acceptance", () => {
  it("renders the proposed preference, reason, and explicit controls without persisting", () => {
    const markup = renderToStaticMarkup(createElement(PreferenceCard, { proposal }));
    expect(markup).toContain(proposal.preference);
    expect(markup).toContain(proposal.reason);
    expect(markup).toContain("Accept preference");
    expect(markup).toContain("Reject");
    expect(markup).toContain("only after you explicitly accept");
    expect(rejectPreferenceProposal()).toBe("rejected");
  });
  it("posts the exact accept-only contract once and requires profile confirmation", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ok: true,
      data: { profile: { preferences: [proposal.preference] } },
    }));

    await expect(acceptPreferenceProposal(proposal, fetcher)).resolves.toMatchObject({
      preferences: [proposal.preference],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/vault/preferences/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: proposal.id,
        preference: proposal.preference,
        reason: proposal.reason,
        accepted: true,
      }),
    });
  });

  it("does not allow accept or reject while saving or after a terminal choice", () => {
    expect(canStartPreferenceAccept("proposed", false)).toBe(true);
    expect(canStartPreferenceAccept("error", false)).toBe(true);
    expect(canStartPreferenceAccept("accepting", true)).toBe(false);
    expect(canStartPreferenceAccept("accepted", false)).toBe(false);
    expect(canRejectPreference("proposed", false)).toBe(true);
    expect(canRejectPreference("accepting", true)).toBe(false);
    expect(canRejectPreference("rejected", false)).toBe(false);
  });

  it("keeps a failed or unconfirmed persistence attempt retryable", async () => {
    const failed = vi.fn(async () => Response.json(
      { ok: false, error: { message: "Profile write failed" } },
      { status: 500 },
    ));
    await expect(acceptPreferenceProposal(proposal, failed)).rejects.toThrow("Profile write failed");

    const unconfirmed = vi.fn(async () => Response.json({
      ok: true,
      data: { profile: { preferences: [] } },
    }));
    await expect(acceptPreferenceProposal(proposal, unconfirmed)).rejects.toThrow(/did not confirm/);
  });

  it("accepts and rejects a server-bound structured proposal with exact CAS fields", async () => {
    const structuredProposal: PreferenceProposalEvent = {
      ...proposal,
      structured: {
        recordId: "proposal:abc123",
        revision: 4,
        version: 1,
        category: "workflow",
        key: "route_preference",
        origin: "inferred",
        confidence: 0.5,
      },
    };
    const accept = vi.fn(async () => Response.json({
      ok: true,
      data: { record: { id: "proposal:abc123", status: "accepted" } },
    }));
    await expect(
      acceptPreferenceProposal(structuredProposal, accept, "ui:accept-1"),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(accept).toHaveBeenCalledWith("/api/vault/preferences/structured", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "accept",
        recordId: "proposal:abc123",
        expectedRevision: 4,
        expectedVersion: 1,
        idempotencyKey: "ui:accept-1",
      }),
    });

    const reject = vi.fn(async () => Response.json({
      ok: true,
      data: { record: { id: "proposal:abc123", status: "rejected" } },
    }));
    await expect(
      rejectStructuredPreferenceProposal(structuredProposal, "ui:reject-1", reject),
    ).resolves.toBeUndefined();
    expect(reject).toHaveBeenCalledWith("/api/vault/preferences/structured", expect.objectContaining({
      body: JSON.stringify({
        action: "reject",
        recordId: "proposal:abc123",
        expectedRevision: 4,
        expectedVersion: 1,
        idempotencyKey: "ui:reject-1",
      }),
    }));
  });

  it("requires an idempotency key and exact confirmation for structured acceptance", async () => {
    const structuredProposal: PreferenceProposalEvent = {
      ...proposal,
      structured: {
        recordId: "proposal:abc123",
        revision: 4,
        version: 1,
        category: "workflow",
        key: "route_preference",
        origin: "inferred",
        confidence: 0.5,
      },
    };
    await expect(acceptPreferenceProposal(structuredProposal, vi.fn())).rejects.toThrow(/identify/);
    const unconfirmed = vi.fn(async () => Response.json({
      ok: true,
      data: { record: { id: "proposal:other", status: "accepted" } },
    }));
    await expect(
      acceptPreferenceProposal(structuredProposal, unconfirmed, "ui:accept-2"),
    ).rejects.toThrow(/did not confirm/);
  });

  it("forces a fresh card lifecycle when a same-copy structured authority binding changes", () => {
    const first: PreferenceProposalEvent = {
      ...proposal,
      structured: {
        recordId: "proposal:abc123",
        revision: 4,
        version: 1,
        category: "workflow",
        key: "route_preference",
        origin: "inferred",
        confidence: 0.5,
      },
    };
    const refreshed = {
      ...first,
      structured: { ...first.structured!, revision: 5, version: 2 },
    };
    expect(preferenceProposalRenderKey(refreshed)).not.toBe(preferenceProposalRenderKey(first));
    expect(preferenceProposalRenderKey({ ...first })).toBe(preferenceProposalRenderKey(first));
  });

  it("rebases an unchanged earlier proposal after an unrelated revision and requires a fresh explicit retry", async () => {
    const first: PreferenceProposalEvent = {
      ...proposal,
      structured: {
        recordId: "proposal:first",
        revision: 1,
        version: 1,
        category: "workflow",
        key: "route_preference",
        origin: "explicit",
        confidence: 1,
      },
    };
    const conflict = vi.fn(async () => Response.json(
      { ok: false, error: { message: "Structured preference revision conflict" } },
      { status: 409 },
    ));
    await expect(
      acceptPreferenceProposal(first, conflict, "ui:stale-accept"),
    ).rejects.toBeInstanceOf(PreferenceProposalConflictError);

    const list = vi.fn(async () => Response.json({
      ok: true,
      data: {
        revision: 2,
        records: [
          {
            id: "proposal:first",
            status: "proposed",
            value: proposal.preference,
            version: 1,
            category: "workflow",
            key: "route_preference",
            origin: "explicit",
            confidence: 1,
          },
          { id: "proposal:second", status: "proposed", value: "Prefer bullets", version: 1 },
        ],
      },
    }));
    const refreshed = await refreshStructuredPreferenceProposal(first, list);
    expect(refreshed.structured?.revision).toBe(2);
    expect(list).toHaveBeenCalledWith("/api/vault/preferences/structured", expect.objectContaining({
      body: JSON.stringify({ action: "list" }),
    }));

    const retried = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: true,
      data: { record: { id: "proposal:first", status: "accepted" } },
    }));
    await acceptPreferenceProposal(refreshed, retried, "ui:fresh-accept");
    expect(JSON.parse(String(retried.mock.calls[0]?.[1]?.body))).toMatchObject({
      expectedRevision: 2,
      expectedVersion: 1,
      idempotencyKey: "ui:fresh-accept",
    });
  });

  it("refuses to rebase a proposal whose record changed", async () => {
    const first: PreferenceProposalEvent = {
      ...proposal,
      structured: {
        recordId: "proposal:first",
        revision: 1,
        version: 1,
        category: "workflow",
        key: "route_preference",
        origin: "explicit",
        confidence: 1,
      },
    };
    const changed = vi.fn(async () => Response.json({
      ok: true,
      data: {
        revision: 2,
        records: [{
          id: "proposal:first",
          status: "proposed",
          value: "Changed value",
          version: 2,
          category: "workflow",
          key: "route_preference",
          origin: "explicit",
          confidence: 1,
        }],
      },
    }));
    await expect(refreshStructuredPreferenceProposal(first, changed)).rejects.toThrow(/changed/);
  });
});
