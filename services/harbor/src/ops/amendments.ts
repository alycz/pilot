import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpDef } from "../catalog/registry";
import { NetworkSchema } from "../contracts";

const HASH_256 = /^[A-Fa-f0-9]{64}$/;
const SHORT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const AmendmentSelectorSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => HASH_256.test(value) || SHORT_NAME.test(value),
    "must be an amendment short name or 64-character hexadecimal ID",
  );

const AmendmentStatusArgsSchema = z
  .object({
    network: NetworkSchema,
    amendment: AmendmentSelectorSchema.optional(),
  })
  .strict();

const AmendmentFeatureSchema = z
  .object({
    enabled: z.boolean(),
    name: z.string().min(1).optional(),
    supported: z.boolean(),
  })
  .strict();

const FeatureTableSchema = z.record(
  z.string().regex(HASH_256),
  AmendmentFeatureSchema,
);
const WrappedFeatureResponseSchema = z
  .object({
    features: FeatureTableSchema,
    status: z.literal("success").optional(),
  })
  .strict();

function parseFeatureTable(
  result: Record<string, unknown>,
): z.infer<typeof FeatureTableSchema> {
  const wrapped = WrappedFeatureResponseSchema.safeParse(result);
  if (wrapped.success) return wrapped.data.features;

  const direct: Record<string, unknown> = { ...result };
  if (direct.status === "success") delete direct.status;
  return FeatureTableSchema.parse(direct);
}

function protocolStatus(enabled: boolean, supported: boolean) {
  if (enabled && supported) return "enabled" as const;
  if (enabled) return "enabled-unsupported" as const;
  if (supported) return "supported-not-enabled" as const;
  return "unsupported" as const;
}

// The public `feature` method is read-only when no admin-only `vetoed` field is
// sent. Its `supported` flag means this server knows how to apply an amendment;
// it does not mean that validators have voted for it.
// https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/feature
export const ops: OpDef[] = [
  {
    name: "amendments.status",
    family: "amendments",
    summary: "Read network-specific XRPL amendment enablement and server support.",
    tags: ["amendments", "features", "protocol", "support"],
    args: AmendmentStatusArgsSchema,
    returns: "amendment IDs with network-specific enabled and supported flags",
    caveats: ["amendment-pending"],
    example:
      'await harbor.amendments.status({ network: "devnet", amendment: "LendingProtocolV1_1" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof AmendmentStatusArgsSchema>;
      const table = parseFeatureTable(
        await requestXrpl(ctx, args.network, "feature", {
          ...(args.amendment === undefined
            ? {}
            : { feature: args.amendment }),
        }),
      );
      const amendments = Object.entries(table)
        .map(([id, feature]) => ({
          id,
          ...(feature.name === undefined ? {} : { name: feature.name }),
          enabled: feature.enabled,
          supported: feature.supported,
          status: protocolStatus(feature.enabled, feature.supported),
        }))
        .sort((left, right) =>
          (left.name ?? left.id).localeCompare(right.name ?? right.id),
        );

      return {
        network: args.network,
        ...(args.amendment === undefined ? {} : { query: args.amendment }),
        amendments,
      };
    },
  },
];
