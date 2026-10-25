import { z } from "zod";

const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((day) => {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
}, "date must be a real UTC calendar day");

const DecimalSchema = z.string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/, "must be a bounded canonical nonnegative decimal");

export const BacktestRunRequestSchema = z.object({
  startDay: UtcDaySchema,
  endDay: UtcDaySchema,
  outOfSampleStartDay: UtcDaySchema,
  initialBase: DecimalSchema,
  initialQuote: DecimalSchema,
  targetBaseBps: z.number().int().min(1).max(9_999),
  bandBps: z.number().int().min(0).max(4_999),
  maxTradeQuote: DecimalSchema.refine((value) => value !== "0", "maximum trade value must be positive"),
  spreadBps: z.number().int().min(0).max(5_000),
  venueFeeBps: z.number().int().min(0).max(5_000),
  slippageBps: z.number().int().min(0).max(5_000),
  networkCostQuote: DecimalSchema,
  embargoBars: z.number().int().min(1).max(30),
  hypothesis: z.string().trim().min(1).max(500)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "hypothesis must not contain control characters"),
}).strict().superRefine((input, context) => {
  if (input.startDay > input.endDay) {
    context.addIssue({ code: "custom", path: ["endDay"], message: "end date must not precede start date" });
  }
  if (input.outOfSampleStartDay <= input.startDay || input.outOfSampleStartDay > input.endDay) {
    context.addIssue({ code: "custom", path: ["outOfSampleStartDay"], message: "out-of-sample start must be inside the requested window" });
  }
  if (input.targetBaseBps - input.bandBps < 0 || input.targetBaseBps + input.bandBps > 10_000) {
    context.addIssue({ code: "custom", path: ["bandBps"], message: "allocation band must stay inside portfolio bounds" });
  }
  if (input.spreadBps + input.venueFeeBps + input.slippageBps >= 10_000) {
    context.addIssue({ code: "custom", path: ["slippageBps"], message: "combined proportional costs must remain below 10,000 bps" });
  }
  if (input.initialBase === "0" && input.initialQuote === "0") {
    context.addIssue({ code: "custom", path: ["initialQuote"], message: "starting portfolio must contain value" });
  }
});

export type ParsedBacktestRunRequest = z.infer<typeof BacktestRunRequestSchema>;
