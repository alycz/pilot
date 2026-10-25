import { z } from "zod";

const OwnerSchema = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
const ReferenceSchema = z.string().regex(/^cap_v1_[A-Za-z0-9_-]{32,128}$/);
const RequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const BaseSchema = z.object({
  version: z.literal(1),
  owner: OwnerSchema,
  network: z.literal("testnet"),
}).strict();

export const CapabilityRecoverySchema = z.discriminatedUnion("phase", [
  BaseSchema.extend({
    phase: z.literal("prepare_pending"),
    started_at: z.string().datetime(),
  }).strict(),
  BaseSchema.extend({
    phase: z.literal("prepare_unknown"),
    started_at: z.string().datetime(),
  }).strict(),
  BaseSchema.extend({
    phase: z.literal("tracking"),
    capability_ref: ReferenceSchema,
  }).strict(),
  BaseSchema.extend({
    phase: z.literal("revoke_prepare_pending"),
    capability_ref: ReferenceSchema,
    generation: z.number().int().min(1),
    request_id: RequestIdSchema,
  }).strict(),
  BaseSchema.extend({
    phase: z.enum(["invoke_pending", "invoke_unknown"]),
    capability_ref: ReferenceSchema,
    generation: z.number().int().min(1),
    request_id: RequestIdSchema,
    resource: z.literal("ledger-docs"),
  }).strict(),
]);

export type CapabilityRecovery = z.infer<typeof CapabilityRecoverySchema>;

export function capabilityRecoveryKey(owner: string): string {
  return `pilot:ledger-capability:v1:${owner}`;
}

export function parseCapabilityRecovery(value: string | null, owner: string): CapabilityRecovery | undefined {
  if (value === null) return undefined;
  try {
    const parsed = CapabilityRecoverySchema.safeParse(JSON.parse(value));
    return parsed.success && parsed.data.owner === owner ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function serializeCapabilityRecovery(recovery: CapabilityRecovery): string {
  return JSON.stringify(CapabilityRecoverySchema.parse(recovery));
}

export function trackedCapabilityReference(recovery: CapabilityRecovery | undefined): string | undefined {
  return recovery && "capability_ref" in recovery ? recovery.capability_ref : undefined;
}

export function recoverableInvocation(recovery: CapabilityRecovery | undefined): Readonly<{
  capabilityRef: string;
  generation: number;
  requestId: string;
}> | undefined {
  if (!recovery || (recovery.phase !== "invoke_pending" && recovery.phase !== "invoke_unknown")) {
    return undefined;
  }
  return {
    capabilityRef: recovery.capability_ref,
    generation: recovery.generation,
    requestId: recovery.request_id,
  };
}
export function recoverableRevocationPreparation(recovery: CapabilityRecovery | undefined): Readonly<{
  capabilityRef: string;
  generation: number;
  requestId: string;
}> | undefined {
  if (!recovery || recovery.phase !== "revoke_prepare_pending") return undefined;
  return {
    capabilityRef: recovery.capability_ref,
    generation: recovery.generation,
    requestId: recovery.request_id,
  };
}
