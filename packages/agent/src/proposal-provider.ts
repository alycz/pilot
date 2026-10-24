import { z } from "zod";

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const BoundedTextSchema = z.string().trim().min(1).max(4_000);
const ShortTextSchema = z.string().trim().min(1).max(500);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const JsonPrimitiveSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export type ProposalJsonValue =
  | string
  | number
  | boolean
  | null
  | ProposalJsonValue[]
  | { [key: string]: ProposalJsonValue };

const JsonValueSchema: z.ZodType<ProposalJsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema).max(32),
    z.record(z.string().min(1).max(128), JsonValueSchema),
  ]),
);

const FORBIDDEN_KEYS = new Set([
  "apikey",
  "authorization",
  "bearer",
  "credential",
  "harborapikey",
  "password",
  "privatekey",
  "secret",
  "seed",
  "signingkey",
  "token",
]);
const FORBIDDEN_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:authorization|bearer|credential|harbor[_ -]?api[_ -]?key|password|private[_ -]?key|secret|seed|signing[_ -]?key)\b\s*[:=]/i,
  /\bs(?:Ed|h|n)[1-9A-HJ-NP-Za-km-z]{20,40}\b/,
];
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_CONTEXT_DEPTH = 5;
const MAX_CONTEXT_ENTRIES = 128;
const REQUIRED_PROCEDURE_INVARIANTS = [
  "no_network",
  "no_execution",
  "no_runtime_rewrite",
  "no_policy_change",
  "no_automatic_promotion",
  "scope_isolation",
] as const;

function inspectText(value: string, path: (string | number)[], context: z.RefinementCtx) {
  if (FORBIDDEN_TEXT.some((pattern) => pattern.test(value))) {
    context.addIssue({
      code: "custom",
      path,
      message: "Credentials and signing material are not accepted",
    });
  }
}

function inspectJson(
  value: ProposalJsonValue,
  path: (string | number)[],
  depth: number,
  state: { entries: number },
  context: z.RefinementCtx,
): void {
  if (depth > MAX_CONTEXT_DEPTH) {
    context.addIssue({ code: "custom", path, message: "Context nesting is too deep" });
    return;
  }
  if (typeof value === "string") {
    inspectText(value, path, context);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    state.entries += 1;
    if (state.entries > MAX_CONTEXT_ENTRIES) {
      context.addIssue({ code: "custom", path, message: "Context has too many entries" });
      return;
    }
    if (FORBIDDEN_KEYS.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase())) {
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "Credential-bearing context fields are not accepted",
      });
    }
    inspectJson(child, [...path, key], depth + 1, state, context);
  }
}

export const ProposalContextSchema = z
  .record(z.string().min(1).max(128), JsonValueSchema)
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_CONTEXT_BYTES) {
      context.addIssue({ code: "custom", message: "Context exceeds the byte limit" });
    }
    inspectJson(value, [], 1, { entries: 0 }, context);
  });

const SafeBoundedTextSchema = BoundedTextSchema.superRefine((value, context) =>
  inspectText(value, [], context),
);
const SafeShortTextSchema = ShortTextSchema.superRefine((value, context) =>
  inspectText(value, [], context),
);

export const ProposalRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    purpose: z.enum(["read", "procedure_proposal"]),
    prompt: BoundedTextSchema.superRefine((value, context) =>
      inspectText(value, ["prompt"], context),
    ),
    context: ProposalContextSchema.default({}),
  })
  .strict();

export type ProposalRequest = z.infer<typeof ProposalRequestSchema>;

export const ProposalEvidenceSchema = z
  .object({
    source: SafeShortTextSchema,
    claim: SafeShortTextSchema,
    freshness: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const DeclarativeProcedureStepSchema = z
  .object({
    id: IdentifierSchema,
    operation: z.enum([
      "read_context",
      "read_memory",
      "read_portfolio",
      "compare_evidence",
      "draft_response",
      "draft_procedure",
      "validate_output",
    ]),
    description: SafeShortTextSchema,
    dependsOn: z.array(IdentifierSchema).max(16).default([]),
  })
  .strict();

type DeclarativeProcedureStep = z.infer<typeof DeclarativeProcedureStepSchema>;

function validateProcedureGraph(
  steps: readonly DeclarativeProcedureStep[],
  context: z.RefinementCtx,
): void {
  const stepIndexes = new Map<string, number>();
  let duplicateStepId = false;
  for (const [index, step] of steps.entries()) {
    const previousIndex = stepIndexes.get(step.id);
    if (previousIndex !== undefined) {
      duplicateStepId = true;
      context.addIssue({
        code: "custom",
        path: ["steps", index, "id"],
        message: `Step id duplicates steps[${previousIndex}].id`,
      });
    } else {
      stepIndexes.set(step.id, index);
    }
  }

  for (const [stepIndex, step] of steps.entries()) {
    const seenDependencies = new Set<string>();
    for (const [dependencyIndex, dependency] of step.dependsOn.entries()) {
      const path = ["steps", stepIndex, "dependsOn", dependencyIndex];
      if (seenDependencies.has(dependency)) {
        context.addIssue({
          code: "custom",
          path,
          message: "Step dependencies must not repeat",
        });
      }
      seenDependencies.add(dependency);
      if (dependency === step.id) {
        context.addIssue({
          code: "custom",
          path,
          message: "A step cannot depend on itself",
        });
      } else if (!stepIndexes.has(dependency)) {
        context.addIssue({
          code: "custom",
          path,
          message: "Step dependency does not name a procedure step",
        });
      }
    }
  }

  // Duplicate node identities make graph traversal ambiguous; their dedicated
  // issue above is sufficient and avoids producing misleading cycle errors.
  if (duplicateStepId) return;

  const state = new Map<string, "visiting" | "visited">();
  const visit = (stepId: string): void => {
    state.set(stepId, "visiting");
    const stepIndex = stepIndexes.get(stepId)!;
    const step = steps[stepIndex]!;
    for (const [dependencyIndex, dependency] of step.dependsOn.entries()) {
      if (dependency === stepId || !stepIndexes.has(dependency)) continue;
      const dependencyState = state.get(dependency);
      if (dependencyState === "visiting") {
        context.addIssue({
          code: "custom",
          path: ["steps", stepIndex, "dependsOn", dependencyIndex],
          message: "Procedure dependencies must form an acyclic graph",
        });
      } else if (dependencyState !== "visited") {
        visit(dependency);
      }
    }
    state.set(stepId, "visited");
  };

  for (const step of steps) {
    if (state.get(step.id) === undefined) visit(step.id);
  }
}

export const DeclarativeProcedureSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema,
    title: SafeShortTextSchema,
    description: SafeBoundedTextSchema,
    steps: z.array(DeclarativeProcedureStepSchema).min(1).max(24),
    invariants: z
      .array(z.enum(REQUIRED_PROCEDURE_INVARIANTS))
      .length(REQUIRED_PROCEDURE_INVARIANTS.length)
      .refine(
        (values) =>
          new Set(values).size === REQUIRED_PROCEDURE_INVARIANTS.length &&
          REQUIRED_PROCEDURE_INVARIANTS.every((invariant) => values.includes(invariant)),
        "All procedure safety invariants are required exactly once",
      ),
  })
  .strict()
  .superRefine((procedure, context) => {
    validateProcedureGraph(procedure.steps, context);
  });

export const ReadOnlyProposalResultSchema = z
  .object({
    kind: z.literal("read_only"),
    summary: SafeBoundedTextSchema,
    evidence: z.array(ProposalEvidenceSchema).max(20).default([]),
    caveats: z.array(SafeShortTextSchema).max(20).default([]),
  })
  .strict();

export const ProcedureProposalResultSchema = z
  .object({
    kind: z.literal("procedure_proposal"),
    procedure: DeclarativeProcedureSchema,
    rationale: SafeBoundedTextSchema,
    risks: z.array(SafeShortTextSchema).max(20).default([]),
  })
  .strict();

export const ProposalResultSchema = z.discriminatedUnion("kind", [
  ReadOnlyProposalResultSchema,
  ProcedureProposalResultSchema,
]);

export type ProposalResult = z.infer<typeof ProposalResultSchema>;

export type ProposalCallOptions = {
  signal?: AbortSignal;
};

export interface ProposalProvider {
  readonly enabled: boolean;
  propose(request: ProposalRequest, options?: ProposalCallOptions): Promise<ProposalResult>;
}
