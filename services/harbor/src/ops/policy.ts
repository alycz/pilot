import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import {
  DEFAULT_POLICY,
  NetworkSchema,
  PolicySchema,
  type Policy,
} from "../contracts";
import type { OpContext, OpDef } from "../catalog/registry";
import {
  Store,
  type PolicyInsert,
  type PolicyRow,
  type PolicyUpdate,
} from "../exec/store";

const OwnerSchema = z
  .string()
  .refine(isValidClassicAddress, "owner must be a valid XRPL classic address");
const NonnegativeFiniteNumberSchema = z.number().finite().nonnegative();
const DropsSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "drops must be a nonnegative integer string");

function addUniqueIssue(
  values: readonly string[],
  field: "allowed_tx_types" | "issuer_allowlist",
  issue: z.core.$RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    issue.addIssue({
      code: "custom",
      path: [field],
      message: `${field} must contain unique values`,
    });
  }
}

export const SafePolicySchema = PolicySchema.extend({
  max_per_tx_usd: NonnegativeFiniteNumberSchema,
  daily_cap_usd: NonnegativeFiniteNumberSchema,
  execute_under_usd: NonnegativeFiniteNumberSchema,
  max_slippage_bps: NonnegativeFiniteNumberSchema,
  allowed_tx_types: z.array(z.string().min(1)),
  issuer_allowlist: z.array(z.string().min(1)),
  networks: z.array(NetworkSchema),
  x402_max_per_call_drops: DropsSchema,
  x402_daily_cap_drops: DropsSchema,
})
  .strict()
  .superRefine((policy, issue) => {
    if (policy.execute_under_usd > policy.max_per_tx_usd) {
      issue.addIssue({
        code: "custom",
        path: ["execute_under_usd"],
        message: "execute_under_usd must be less than or equal to max_per_tx_usd",
      });
    }
    if (policy.max_per_tx_usd > policy.daily_cap_usd) {
      issue.addIssue({
        code: "custom",
        path: ["max_per_tx_usd"],
        message: "max_per_tx_usd must be less than or equal to daily_cap_usd",
      });
    }
    addUniqueIssue(policy.allowed_tx_types, "allowed_tx_types", issue);
    addUniqueIssue(policy.issuer_allowlist, "issuer_allowlist", issue);
    if (policy.networks.includes("mainnet")) {
      issue.addIssue({
        code: "custom",
        path: ["networks"],
        message: "mainnet execution cannot be enabled",
      });
    }
    if (
      new Set(policy.networks).size !== policy.networks.length
    ) {
      issue.addIssue({
        code: "custom",
        path: ["networks"],
        message: "networks must contain unique values",
      });
    }
    if (
      /^(0|[1-9]\d*)$/.test(policy.x402_max_per_call_drops) &&
      /^(0|[1-9]\d*)$/.test(policy.x402_daily_cap_drops) &&
      BigInt(policy.x402_max_per_call_drops) >
        BigInt(policy.x402_daily_cap_drops)
    ) {
      issue.addIssue({
        code: "custom",
        path: ["x402_max_per_call_drops"],
        message:
          "x402_max_per_call_drops must be less than or equal to x402_daily_cap_drops",
      });
    }
  });

export const PolicyGetArgsSchema = z
  .object({
    owner: OwnerSchema,
    network: NetworkSchema,
  })
  .strict();

export const PolicySetArgsSchema = z
  .object({
    owner: OwnerSchema,
    network: NetworkSchema,
    policy: SafePolicySchema,
  })
  .strict();

export type PolicyGetArgs = z.infer<typeof PolicyGetArgsSchema>;
export type PolicySetArgs = z.infer<typeof PolicySetArgsSchema>;

export type PolicyStore = Pick<
  Store,
  "getPolicy" | "insertPolicy" | "updatePolicy"
>;

export interface PolicyServices {
  store?: PolicyStore;
  now?: () => Date;
}

type PolicyContext = OpContext & {
  db?: D1Database;
  policyServices?: PolicyServices;
};

function context(input: OpContext): PolicyContext {
  return input as PolicyContext;
}

function services(input: OpContext): PolicyServices {
  return context(input).policyServices ?? {};
}

function storeFor(input: OpContext, configured: PolicyServices): PolicyStore {
  if (configured.store) return configured.store;
  const db = context(input).db;
  if (!db) throw new Error("policy store is not configured");
  return new Store(db, input.principal);
}

function immutablePolicy(value: Policy): Policy {
  const copy = PolicySchema.parse(value);
  Object.freeze(copy.allowed_tx_types);
  Object.freeze(copy.issuer_allowlist);
  Object.freeze(copy.networks);
  return Object.freeze(copy) as Policy;
}

function requirePolicy(row: PolicyRow | null): PolicyRow {
  if (!row) throw new Error("policy upsert failed");
  return row;
}

export async function handlePolicyGet(
  input: OpContext,
  rawArgs: PolicyGetArgs,
): Promise<Policy> {
  const args = PolicyGetArgsSchema.parse(rawArgs);
  const configured = services(input);
  const row = await storeFor(input, configured).getPolicy(
    args.owner,
    args.network,
  );
  return immutablePolicy(row?.json ?? DEFAULT_POLICY);
}

export async function handlePolicySet(
  input: OpContext,
  rawArgs: PolicySetArgs,
): Promise<Policy> {
  const args = PolicySetArgsSchema.parse(rawArgs);
  const configured = services(input);
  const policyStore = storeFor(input, configured);
  const existing = await policyStore.getPolicy(args.owner, args.network);
  const updatedAt = (configured.now ?? (() => new Date()))().toISOString();

  let row: PolicyRow;
  if (existing) {
    row = requirePolicy(
      await policyStore.updatePolicy(args.owner, args.network, {
        json: args.policy,
        updatedAt,
      } satisfies PolicyUpdate),
    );
  } else {
    try {
      row = await policyStore.insertPolicy({
        owner: args.owner,
        network: args.network,
        json: args.policy,
        updatedAt,
      } satisfies PolicyInsert);
    } catch (error) {
      // Recover when another request wins the composite-key insert race. The
      // Store remains the principal-scoped authority for both reads and writes.
      if (!(await policyStore.getPolicy(args.owner, args.network))) throw error;
      row = requirePolicy(
        await policyStore.updatePolicy(args.owner, args.network, {
          json: args.policy,
          updatedAt,
        } satisfies PolicyUpdate),
      );
    }
  }

  return immutablePolicy(row.json);
}

export const ops: OpDef[] = [
  {
    name: "policy.get",
    family: "policy",
    summary: "Read the principal-scoped execution policy or the safe default.",
    tags: ["policy", "safety", "limits"],
    args: z
      .object({
        owner: OwnerSchema,
        network: NetworkSchema,
      })
      .strict(),
    returns: "Policy",
    caveats: [],
    example:
      'await harbor.policy.get({ owner: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", network: "testnet" })',
    handler: (ctx, args) =>
      handlePolicyGet(ctx, PolicyGetArgsSchema.parse(args)),
  },
  {
    name: "policy.set",
    family: "policy",
    summary: "Validate and upsert the principal-scoped execution policy.",
    tags: ["policy", "safety", "limits"],
    args: z
      .object({
        owner: OwnerSchema,
        network: NetworkSchema,
        policy: SafePolicySchema,
      })
      .strict(),
    returns: "Policy",
    caveats: [],
    example:
      'await harbor.policy.set({ owner: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", network: "testnet", policy: { max_per_tx_usd: 2000, daily_cap_usd: 5000, execute_under_usd: 250, max_slippage_bps: 100, allowed_tx_types: ["OfferCreate"], issuer_allowlist: ["RLUSD"], block_requireauth_issuers: true, networks: ["testnet", "devnet"], x402_max_per_call_drops: "10000", x402_daily_cap_drops: "1000000" } })',
    handler: (ctx, args) =>
      handlePolicySet(ctx, PolicySetArgsSchema.parse(args)),
  },
];
