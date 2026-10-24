import {
  BLOCKED_FIELD_KIND_LIMIT,
  BlockedFieldKindSchema,
} from "@pilot/contracts";
import { z } from "zod";

const NOTICE_COUNT_LIMIT = 10_000;
const GuardrailBlockedFieldKindSchema = z.enum(
  BlockedFieldKindSchema.options,
);

/**
 * Presentation-safe subset of Harbor screening metadata. Raw field paths,
 * values, keys, and tool results are deliberately not part of this contract.
 */
export const GuardrailNoticeSchema = z
  .object({
    provider: z.enum(["aws-bedrock-guardrails", "mock"]),
    caveat: z.literal("screened-redacted"),
    fields_checked: z.number().int().min(1).max(NOTICE_COUNT_LIMIT),
    fields_blocked: z.number().int().min(1).max(NOTICE_COUNT_LIMIT),
    blocked_field_kinds: z
      .array(GuardrailBlockedFieldKindSchema)
      .min(1)
      .max(BLOCKED_FIELD_KIND_LIMIT)
      .refine((kinds) => new Set(kinds).size === kinds.length, {
        message: "blocked field kinds must be unique",
      }),
  })
  .strict()
  .refine((notice) => notice.fields_blocked <= notice.fields_checked, {
    message: "blocked field count cannot exceed checked field count",
    path: ["fields_blocked"],
  });

export type GuardrailNotice = z.infer<typeof GuardrailNoticeSchema>;
export type GuardrailNoticeSink = (
  notice: GuardrailNotice,
) => void | Promise<void>;

/**
 * Projects an unknown Harbor envelope into the fixed safe notice contract.
 * The original result is never copied into the UI data part.
 */
export function guardrailNoticeFromEnvelope(
  value: unknown,
): GuardrailNotice | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  if (
    !Array.isArray(value.caveat) ||
    !value.caveat.includes("screened-redacted")
  ) {
    return undefined;
  }
  if (!isRecord(value.trust) || !isRecord(value.trust.screen)) {
    return undefined;
  }

  const screen = value.trust.screen;
  const candidate = {
    provider: screen.provider,
    caveat: "screened-redacted" as const,
    fields_checked: screen.fields_checked,
    fields_blocked: screen.fields_blocked,
    blocked_field_kinds: screen.blocked_field_kinds,
  };
  const parsed = GuardrailNoticeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
