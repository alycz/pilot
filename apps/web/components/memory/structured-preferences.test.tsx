import { describe, expect, it, vi } from "vitest";

import {
  requestStructuredPreferences,
  normalizedStructuredPreferenceCorrection,
  shouldApplyStructuredPreferenceResponse,
  StructuredPreferenceConflictError,
  StructuredPreferenceMutationGuard,
  StructuredPreferenceRequestCache,
  StructuredPreferencesDisabledError,
  structuredPreferenceFailureAction,
} from "./structured-preferences";
import type { StructuredPreferenceRecord } from "@pilot/vault";

const record = {
  id: "pref-1",
  version: 2,
} as StructuredPreferenceRecord;

describe("structured preference client", () => {
  it("posts only the requested action and validates the server revision", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ok: true,
      data: { revision: 2, records: [] },
    }));
    await expect(requestStructuredPreferences({ action: "list" }, fetcher)).resolves.toEqual({
      revision: 2,
      records: [],
    });
    expect(fetcher).toHaveBeenCalledWith("/api/vault/preferences/structured", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
  });

  it("treats the default-off response as a hidden optional feature", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ok: false,
      error: {
        code: "STRUCTURED_PREFERENCES_DISABLED",
        message: "Structured preferences are disabled",
      },
    }, { status: 404 }));
    await expect(requestStructuredPreferences({ action: "list" }, fetcher))
      .rejects.toBeInstanceOf(StructuredPreferencesDisabledError);
  });

  it("does not accept an unconfirmed or malformed mutation", async () => {
    const malformed = vi.fn(async () => Response.json({ ok: true, data: { records: [] } }));
    await expect(requestStructuredPreferences({ action: "list" }, malformed))
      .rejects.toThrow(/invalid structured preference confirmation/i);
    const rejected = vi.fn(async () => Response.json({
      ok: false,
      error: { message: "Structured preference revision conflict" },
    }, { status: 400 }));
    await expect(requestStructuredPreferences({
      action: "forget",
      recordId: "pref-1",
      expectedRevision: 2,
      expectedVersion: 2,
      idempotencyKey: "forget:pref-1:test",
    }, rejected)).rejects.toThrow(/revision conflict/i);
  });

  it("reuses the exact request after a lost response and blocks same-tick double submit", () => {
    const cache = new StructuredPreferenceRequestCache();
    const first = cache.mutation(record, 3, "correct", "Prefer bullets");
    const retry = cache.mutation(record, 3, "correct", "Prefer bullets");
    expect(retry).toBe(first);
    expect((retry as { idempotencyKey: string }).idempotencyKey)
      .toBe((first as { idempotencyKey: string }).idempotencyKey);
    expect((first as { idempotencyKey: string }).idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(cache.mutation(record, 3, "correct", "Prefer tables")).not.toBe(first);

    const guard = new StructuredPreferenceMutationGuard();
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    guard.end();
    expect(guard.begin()).toBe(true);
    expect(normalizedStructuredPreferenceCorrection("   ")).toBeUndefined();
    expect(normalizedStructuredPreferenceCorrection("  Prefer tables  ")).toBe("Prefer tables");
  });

  it("classifies conflicts for refresh and rejects stale scope generations", async () => {
    const conflict = vi.fn(async () => Response.json({
      ok: false,
      error: { message: "Structured preference revision conflict" },
    }, { status: 409 }));
    let cause: unknown;
    try {
      await requestStructuredPreferences({ action: "list" }, conflict);
    } catch (error) {
      cause = error;
    }
    expect(cause).toBeInstanceOf(StructuredPreferenceConflictError);
    expect(structuredPreferenceFailureAction(cause)).toBe("reload");
    expect(shouldApplyStructuredPreferenceResponse(4, 4)).toBe(true);
    expect(shouldApplyStructuredPreferenceResponse(4, 5)).toBe(false);
  });
});
