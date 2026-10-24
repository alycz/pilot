import { createHash } from "node:crypto";

import {
  createRedactedProposalContext,
  isHermesProviderBoundToLeaseAuthority,
  type HermesCompletionUsage,
} from "@pilot/agent/hermes-transport";
import type { ProposalProvider, ProposalResult } from "@pilot/agent/proposal-provider";
import {
  WorkflowLessonTargetSchema,
  type WorkflowLessonTarget,
} from "@pilot/agent/workflow-lessons";
import { z } from "zod";

import type {
  HermesConsentDisclosure,
  HermesConsentScope,
  ValidatedHermesConsentRecord,
} from "./hermes-consent";
import { isValidatedHermesConsentRecordFor } from "./hermes-consent";

const MAX_DAILY_CALLS = 20;
const MAX_USAGE_MONITOR_SCOPES = 1_024;
const MAX_USAGE_EVENTS = 1_024;

const DisclosureSchema = z.object({
  provider: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  dataPolicy: z.literal("bounded-redacted-proposals"),
  retentionDays: z.number().int().min(1).max(30),
  termsVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

export const HermesWorkflowAdvisorySchema = z.object({
  schemaVersion: z.literal("pilot.hermes-workflow-advisory.v1"),
  summary: z.string().trim().min(1).max(1_000),
  caveats: z.array(z.string().trim().min(1).max(300)).max(8),
  disclosure: DisclosureSchema,
  usage: z.object({
    callsRemainingToday: z.number().int().min(0).max(MAX_DAILY_CALLS),
    promptTokens: z.number().int().min(0).max(1_000_000).optional(),
    completionTokens: z.number().int().min(0).max(1_000_000).optional(),
    totalTokens: z.number().int().min(0).max(1_000_000).optional(),
  }).strict(),
}).strict();

export type HermesWorkflowAdvisory = z.infer<typeof HermesWorkflowAdvisorySchema>;

export type HermesWorkflowLessonInput = Readonly<{
  recordId: string;
  revision: number;
  version: number;
  target: WorkflowLessonTarget;
  evidenceCount: number;
}>;

export type HermesWorkflowUsageEvent = Readonly<{
  scopeDigest: string;
  day: string;
  provider: string;
  model: string;
  profile: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}>;

export interface HermesWorkflowUsageMonitor {
  reserve(scopeDigest: string, now: Date): Promise<{ callsRemainingToday: number }>;
  record(event: HermesWorkflowUsageEvent): Promise<void>;
}

export interface HermesWorkflowAdvisor {
  readonly enabled: boolean;
  advise(input: HermesWorkflowLessonInput, signal?: AbortSignal): Promise<HermesWorkflowAdvisory>;
}

export type HermesWorkflowAdvisorDependencies = Readonly<{
  provider: ProposalProvider;
  profile: string;
  consent: ValidatedHermesConsentRecord | null;
  consentScope: HermesConsentScope;
  disclosure: HermesConsentDisclosure;
  usageMonitor: HermesWorkflowUsageMonitor;
  /** Exact concrete lease authority identity used to construct the provider. */
  leaseAuthorityProof: object;
  /** Rechecks the pinned immutable profile snapshot immediately before and after a turn. */
  assertProfileUnchanged: () => Promise<void>;
  now?: () => Date;
  readUsage?: (requestId: string) => HermesCompletionUsage | undefined;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scopeDigest(scope: HermesConsentScope): string {
  return digest(JSON.stringify({
    tenantId: scope.tenantId,
    owner: scope.owner,
    network: scope.network,
  }));
}

function requestId(input: HermesWorkflowLessonInput): string {
  return `lesson-advice-${digest(JSON.stringify(input)).slice(0, 32)}`;
}

function assertInput(input: HermesWorkflowLessonInput): void {
  if (
    !/^lesson:[0-9a-f]{32}$/.test(input.recordId) ||
    !Number.isSafeInteger(input.revision) || input.revision < 0 ||
    !Number.isSafeInteger(input.version) || input.version < 1 ||
    !Number.isSafeInteger(input.evidenceCount) || input.evidenceCount < 1 ||
    input.evidenceCount > 20 ||
    !WorkflowLessonTargetSchema.safeParse(input.target).success
  ) {
    throw new Error("Invalid workflow lesson advisory input");
  }
}

export function createDisabledHermesWorkflowAdvisor(): HermesWorkflowAdvisor {
  return {
    enabled: false,
    async advise() {
      throw new Error("Hermes workflow advisory is disabled");
    },
  };
}

/**
 * Creates an advisory-only lesson reviewer. The deterministic Pilot lesson is
 * already fixed before this runs; Hermes may explain it but cannot select,
 * persist, promote, execute, sign, or change the target.
 */
export function createHermesWorkflowAdvisor(
  dependencies: HermesWorkflowAdvisorDependencies,
): HermesWorkflowAdvisor {
  const disclosure = DisclosureSchema.parse(dependencies.disclosure);
  if (
    !dependencies.provider.enabled ||
    !isValidatedHermesConsentRecordFor(
      dependencies.consent,
      dependencies.consentScope,
      disclosure,
    ) ||
    !isHermesProviderBoundToLeaseAuthority(
      dependencies.provider,
      dependencies.leaseAuthorityProof,
    )
  ) {
    return createDisabledHermesWorkflowAdvisor();
  }
  const opaqueScope = scopeDigest(dependencies.consentScope);

  return {
    enabled: true,
    async advise(input, signal) {
      assertInput(input);
      await dependencies.assertProfileUnchanged();
      const now = (dependencies.now ?? (() => new Date()))();
      if (!Number.isFinite(now.getTime())) throw new Error("Invalid Hermes usage time");
      const reservation = await dependencies.usageMonitor.reserve(opaqueScope, now);
      let observedUsage: HermesCompletionUsage | undefined;
      const currentRequestId = requestId(input);
      let result: ProposalResult;
      try {
        result = await dependencies.provider.propose({
          requestId: currentRequestId,
          purpose: "read",
          prompt: [
            "Explain the fixed review-only workflow lesson in plain language.",
            "State why it may improve future presentation or research responses and list caveats.",
            "Do not change the lesson, propose execution, or infer any wallet, trade, policy, or identity data.",
          ].join(" "),
          context: createRedactedProposalContext({
            entries: [
              {
                kind: "redacted_text",
                field: "procedure_summary",
                value: `${input.target.category}:${input.target.value}`,
              },
              { kind: "metric", field: "evidence_count", value: input.evidenceCount },
              { kind: "flag", field: "is_redacted_replay", value: false },
            ],
          }),
        }, { signal });
      } catch (error) {
        // A concurrent consent/profile change must win even when the transport
        // also failed closed while settling its durable session lifecycle.
        await dependencies.assertProfileUnchanged();
        throw error;
      }
      observedUsage = dependencies.readUsage?.(currentRequestId);
      if (observedUsage && (
        observedUsage.requestId !== currentRequestId ||
        observedUsage.profile !== dependencies.profile ||
        observedUsage.provider !== disclosure.provider ||
        observedUsage.model !== disclosure.model
      )) {
        throw new Error("Hermes usage does not match the current advisory request");
      }
      await dependencies.assertProfileUnchanged();
      if (result.kind !== "read_only") {
        throw new Error("Hermes returned the wrong workflow advisory kind");
      }
      const advisory = HermesWorkflowAdvisorySchema.parse({
        schemaVersion: "pilot.hermes-workflow-advisory.v1",
        summary: result.summary,
        caveats: result.caveats,
        disclosure,
        usage: {
          callsRemainingToday: reservation.callsRemainingToday,
          ...(observedUsage ? {
            promptTokens: observedUsage.promptTokens,
            completionTokens: observedUsage.completionTokens,
            totalTokens: observedUsage.totalTokens,
          } : {}),
        },
      });
      if (observedUsage) {
        await dependencies.usageMonitor.record({
          scopeDigest: opaqueScope,
          day: now.toISOString().slice(0, 10),
          provider: disclosure.provider,
          model: disclosure.model,
          profile: dependencies.profile,
          promptTokens: observedUsage.promptTokens,
          completionTokens: observedUsage.completionTokens,
          totalTokens: observedUsage.totalTokens,
        });
      }
      return advisory;
    },
  };
}

/** Process-local monitoring is defense in depth; the egress lease owns the hard call cap. */
export function createProcessHermesUsageMonitor(
  dailyLimit: number,
): HermesWorkflowUsageMonitor & { snapshot(): readonly HermesWorkflowUsageEvent[] } {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > MAX_DAILY_CALLS) {
    throw new Error("Hermes daily call limit must be between 1 and 20");
  }
  const calls = new Map<string, number>();
  const events: HermesWorkflowUsageEvent[] = [];
  return {
    async reserve(identity, now) {
      if (!/^[a-f0-9]{64}$/.test(identity) || !Number.isFinite(now.getTime())) {
        throw new Error("Invalid Hermes usage scope");
      }
      const day = now.toISOString().slice(0, 10);
      const key = `${day}:${identity}`;
      for (const existing of calls.keys()) {
        if (!existing.startsWith(`${day}:`)) calls.delete(existing);
      }
      const used = calls.get(key) ?? 0;
      if (used >= dailyLimit) throw new Error("Hermes daily advisory limit reached");
      if (!calls.has(key) && calls.size >= MAX_USAGE_MONITOR_SCOPES) {
        throw new Error("Hermes usage monitor capacity reached");
      }
      calls.set(key, used + 1);
      return { callsRemainingToday: dailyLimit - used - 1 };
    },
    async record(event) {
      events.push(Object.freeze({ ...event }));
      if (events.length > MAX_USAGE_EVENTS) {
        events.splice(0, events.length - MAX_USAGE_EVENTS);
      }
    },
    snapshot() {
      return Object.freeze(events.map((event) => Object.freeze({ ...event })));
    },
  };
}
