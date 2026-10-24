import { createHash } from "node:crypto";

import type {
  StructuredPreferenceCommand,
  StructuredPreferenceEvidence,
  StructuredPreferenceScope,
  StructuredPreferenceSnapshot,
} from "@pilot/vault";
import { resolveStructuredPreferenceTenant } from "../../../../../lib/structured-preferences";

import {
  assertPreferenceAcceptanceAuthorized,
  errorResponse,
  json,
  objectBody,
  requiredString,
} from "../../_lib/http";
import { getVaultService } from "../../_lib/service";

export const runtime = "nodejs";

const CLIENT_SCOPE_FIELDS = ["tenantId", "tenant_id", "owner", "network"] as const;

function integer(body: Record<string, unknown>, key: string, minimum: number): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${key} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function boundedString(body: Record<string, unknown>, key: string, maximum: number): string {
  const value = requiredString(body, key).trim();
  if (value.length > maximum) throw new Error(`${key} must not exceed ${maximum} characters`);
  return value;
}

function rejectClientScope(body: Record<string, unknown>): void {
  if (CLIENT_SCOPE_FIELDS.some((field) => Object.hasOwn(body, field))) {
    throw new Error("Preference scope is server-derived and cannot be supplied by the client");
  }
}

function assertExactActionBody(body: Record<string, unknown>, action: string): void {
  const mutation = [
    "action",
    "recordId",
    "expectedRevision",
    "expectedVersion",
    "idempotencyKey",
  ];
  const allowed = new Set(
    action === "list" ? ["action"] : action === "correct" ? [...mutation, "value"] : mutation,
  );
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new Error("Structured preference request contains unsupported fields");
  }
}

function correctionEvidence(idempotencyKey: string, now: Date): StructuredPreferenceEvidence {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 24);
  return { messageIds: [`ui-correction:${digest}`], observedAt: now.toISOString() };
}

function replacementId(recordId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${recordId}\0${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `correction:${digest}`;
}

function publicSnapshot(result: StructuredPreferenceSnapshot) {
  return { revision: result.revision, records: result.records };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const walletScope = assertPreferenceAcceptanceAuthorized(request);
    if (!walletScope) {
      throw new Error("Structured preferences require a wallet-bound browser session");
    }
    const body = await objectBody(request);
    rejectClientScope(body);
    const tenantId = resolveStructuredPreferenceTenant();
    if (!tenantId) {
      return json({
        ok: false,
        error: { code: "STRUCTURED_PREFERENCES_DISABLED", message: "Structured preferences are disabled" },
      }, 404);
    }
    const scope: StructuredPreferenceScope = { tenantId, ...walletScope };
    const action = requiredString(body, "action");
    assertExactActionBody(body, action);
    const service = getVaultService();
    if (action === "list") {
      const snapshot = await service.readStructuredPreferences(scope);
      return json({ ok: true, data: publicSnapshot(snapshot) });
    }
    if (action !== "accept" && action !== "reject" && action !== "correct" && action !== "forget") {
      throw new Error("Unsupported structured preference action");
    }
    const recordId = boundedString(body, "recordId", 128);
    const expectedRevision = integer(body, "expectedRevision", 0);
    const expectedVersion = integer(body, "expectedVersion", 1);
    const idempotencyKey = boundedString(body, "idempotencyKey", 128);
    const now = new Date();
    let command: StructuredPreferenceCommand;
    if (action === "correct") {
      const value = boundedString(body, "value", 500);
      command = {
        action,
        recordId,
        expectedRevision,
        expectedVersion,
        idempotencyKey,
        replacementId: replacementId(recordId, idempotencyKey),
        value,
        evidence: correctionEvidence(idempotencyKey, now),
        confidence: 1,
      };
    } else {
      command = {
        action,
        recordId,
        expectedRevision,
        expectedVersion,
        idempotencyKey,
      };
    }
    const result = await service.mutateStructuredPreference(scope, command, now);
    return json({
      ok: true,
      data: {
        ...publicSnapshot(result.snapshot),
        ...(result.record ? { record: result.record } : {}),
        idempotent: result.idempotent,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
