import {
  AssetSchema,
  IntentSchema,
  VenueSchema,
  type Asset,
  type Intent,
  type Venue,
} from "@pilot/contracts";
import { z } from "zod";

// Contracts currently use Zod 3 while this package uses the workspace's Zod 4.
// Keep the fixed contract schemas as the runtime authority without composing
// schema instances from the two incompatible major versions.
const CompatibleAssetSchema = z.custom<Asset>(
  (value) => AssetSchema.safeParse(value).success,
  "Invalid Asset contract",
);
const CompatibleIntentSchema = z.custom<Intent>(
  (value) => IntentSchema.safeParse(value).success,
  "Invalid Intent contract",
);
const CompatibleVenueSchema = z.custom<Venue>(
  (value) => VenueSchema.safeParse(value).success,
  "Invalid Venue contract",
);

const ExpectedExecutionSchema = z
  .object({
    fillPrice: z.string().optional(),
    slippageBps: z.number().finite().optional(),
    result: z.string().optional(),
  })
  .strict();

const TokenDetailSchema = z
  .object({
    asset: CompatibleAssetSchema,
    name: z.string().optional(),
    description: z.string().optional(),
    issuerFlags: z.array(z.string()).optional(),
    venues: z.array(z.string()).optional(),
  })
  .strict();

export const ValidatedTransactionSchema = z
  .object({
    intent: CompatibleIntentSchema,
    hash: z.string().regex(/^[A-Fa-f0-9]{64}$/, "hash must be a 64-character XRPL transaction hash"),
    venue: z.string().regex(/^[A-Za-z0-9._-]+$/, "venue must be a safe venue id"),
    assets: z.array(CompatibleAssetSchema).min(1),
    result: z.enum(["filled", "partial", "resting", "success"]),
    fillPrice: z.union([
      z.string().regex(/^\d+(?:\.\d+)?$/, "fillPrice must be a decimal string"),
      z.literal("unavailable"),
    ]),
    slippageBps: z.number().finite().min(0).max(10_000),
    signedBy: z.enum(["delegate", "owner"]),
    created: z.string().datetime({ offset: true }),
    expected: ExpectedExecutionSchema.optional(),
    observations: z.array(z.string().min(1)).optional(),
    summary: z.string().optional(),
    venueDetails: CompatibleVenueSchema.optional(),
    tokenDetails: z.array(TokenDetailSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.venueDetails && value.venueDetails.id !== value.venue) {
      context.addIssue({
        code: "custom",
        path: ["venueDetails", "id"],
        message: "venueDetails.id must match venue",
      });
    }
  });
