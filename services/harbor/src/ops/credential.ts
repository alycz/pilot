import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import type { OpContext, OpDef } from "../catalog/registry";
import {
  normalizeRequiredCredential,
  readCredentialLedgerStatus,
  type CredentialLedgerStatus,
  type RequiredCredential,
} from "../exec/credential-ledger";
import {
  assertHarborSelfCredentialTransaction,
  buildHarborSelfCredentialAccept,
  type HarborSelfCredentialAcceptTransaction,
} from "../exec/credential-self";

const AccountSchema = z
  .string()
  .refine(isValidClassicAddress, "account must be a valid XRPL classic address");

export const CredentialStatusArgsSchema = z
  .object({ account: AccountSchema })
  .strict();
export const CredentialPayerAcceptArgsSchema = z.object({}).strict();
export const CredentialIdsArgsSchema = z
  .object({ account: AccountSchema })
  .strict();

export interface HarborSelfSubmission {
  status: "validated" | "pending" | "failed";
  hash?: string;
  engine_result?: string;
}

export interface CredentialServices {
  demoEnabled?: boolean;
  requiredCredential?: RequiredCredential;
  payerAddress?: string;
  readStatus?: (
    ctx: OpContext,
    account: string,
    requiredCredential: RequiredCredential,
    now: Date,
  ) => Promise<CredentialLedgerStatus | null>;
  submitSelfTransaction?: (input: {
    network: "testnet";
    transaction: HarborSelfCredentialAcceptTransaction;
  }) => Promise<HarborSelfSubmission>;
  now?: () => Date;
}

type CredentialContext = OpContext & {
  env?: Record<string, unknown>;
  credentialServices?: CredentialServices;
};

class CredentialOperationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "AP4M_DISABLED"
      | "CREDENTIAL_CONFIG_REQUIRED"
      | "CREDENTIAL_NOT_ACCEPTABLE"
      | "HARBOR_SELF_SIGNER_REQUIRED"
      | "INVALID_SELF_SUBMISSION",
  ) {
    super(message);
    this.name = "CredentialOperationError";
  }
}

function context(ctx: OpContext): CredentialContext {
  return ctx as CredentialContext;
}

function services(ctx: OpContext): CredentialServices {
  return context(ctx).credentialServices ?? {};
}

function requireDemoProfile(ctx: OpContext): void {
  const configured = services(ctx).demoEnabled;
  const envEnabled = context(ctx).env?.AP4M_DEMO_ENABLED;
  if (configured !== true && envEnabled !== true && envEnabled !== "true") {
    throw new CredentialOperationError(
      "AP4M credential operations are disabled",
      "AP4M_DISABLED",
    );
  }
}

function requiredCredential(ctx: OpContext): RequiredCredential {
  const value = services(ctx).requiredCredential;
  if (value === undefined) {
    throw new CredentialOperationError(
      "AP4M credential configuration is required",
      "CREDENTIAL_CONFIG_REQUIRED",
    );
  }
  return normalizeRequiredCredential(value);
}

function payerAddress(ctx: OpContext): string {
  const value = services(ctx).payerAddress;
  if (typeof value !== "string" || !isValidClassicAddress(value)) {
    throw new CredentialOperationError(
      "The Harbor-self payer is not configured",
      "CREDENTIAL_CONFIG_REQUIRED",
    );
  }
  return value;
}

async function statusFor(
  ctx: OpContext,
  account: string,
): Promise<CredentialLedgerStatus | null> {
  const configured = services(ctx);
  const now = configured.now?.() ?? new Date();
  const read = configured.readStatus ?? readCredentialLedgerStatus;
  return read(ctx, account, requiredCredential(ctx), now);
}

function publicStatus(
  account: string,
  required: RequiredCredential,
  status: CredentialLedgerStatus | null,
) {
  return {
    account,
    network: "testnet" as const,
    issuer: required.issuer,
    credential_type_hex: required.credentialTypeHex,
    ...(status === null ? {} : { credential_id: status.credentialId }),
    accepted: status?.accepted ?? false,
    expired: status?.expired ?? false,
    ...(status?.expiration === undefined
      ? {}
      : { expiration: status.expiration }),
  };
}

function validatedSubmission(
  value: HarborSelfSubmission,
): HarborSelfSubmission {
  if (
    !value ||
    !["validated", "pending", "failed"].includes(value.status) ||
    (value.hash !== undefined &&
      !/^[A-Fa-f0-9]{64}$/.test(value.hash)) ||
    (value.engine_result !== undefined &&
      !/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(value.engine_result))
  ) {
    throw new CredentialOperationError(
      "Harbor-self signer returned an invalid result",
      "INVALID_SELF_SUBMISSION",
    );
  }
  return {
    status: value.status,
    ...(value.hash === undefined ? {} : { hash: value.hash.toUpperCase() }),
    ...(value.engine_result === undefined
      ? {}
      : { engine_result: value.engine_result }),
  };
}

export const ops: OpDef[] = [
  {
    name: "credential.status",
    family: "credential",
    summary:
      "Read the accepted and expiration status of the configured AP4M-Agent credential on XRPL Testnet.",
    tags: ["ap4m", "credential", "testnet", "read"],
    args: CredentialStatusArgsSchema,
    returns: "the configured Testnet credential ledger status",
    caveats: [],
    example:
      'await harbor.credential.status({ account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" })',
    handler: async (ctx, rawArgs) => {
      requireDemoProfile(ctx);
      const args = rawArgs as z.infer<typeof CredentialStatusArgsSchema>;
      const required = requiredCredential(ctx);
      return publicStatus(
        args.account,
        required,
        await statusFor(ctx, args.account),
      );
    },
  },
  {
    name: "credential.payerAccept",
    family: "credential",
    summary:
      "Accept the configured AP4M-Agent credential from Harbor's own Testnet payer account.",
    tags: ["ap4m", "credential", "harbor-self", "testnet"],
    args: CredentialPayerAcceptArgsSchema,
    returns: "the Harbor-self CredentialAccept submission status",
    caveats: [],
    example: "await harbor.credential.payerAccept({})",
    handler: async (ctx) => {
      requireDemoProfile(ctx);
      const account = payerAddress(ctx);
      const required = requiredCredential(ctx);
      const current = await statusFor(ctx, account);
      if (current?.accepted === true && !current.expired) {
        return {
          account,
          credential_id: current.credentialId,
          status: "validated" as const,
        };
      }
      if (current === null || current.expired) {
        throw new CredentialOperationError(
          "The configured payer credential cannot be accepted",
          "CREDENTIAL_NOT_ACCEPTABLE",
        );
      }

      const submit = services(ctx).submitSelfTransaction;
      if (submit === undefined) {
        throw new CredentialOperationError(
          "The Harbor-self signer is not configured",
          "HARBOR_SELF_SIGNER_REQUIRED",
        );
      }
      const transaction = buildHarborSelfCredentialAccept(account, required);
      assertHarborSelfCredentialTransaction(transaction, account);
      const submission = validatedSubmission(
        await submit({ network: "testnet", transaction }),
      );
      return {
        account,
        credential_id: current.credentialId,
        ...submission,
      };
    },
  },
  {
    name: "credential.ids",
    family: "credential",
    summary:
      "Return accepted, unexpired AP4M-Agent CredentialIDs for a Testnet payer.",
    tags: ["ap4m", "credential", "payment", "testnet"],
    args: CredentialIdsArgsSchema,
    returns: "accepted AP4M-Agent CredentialIDs safe to place on a Payment",
    caveats: [],
    example:
      'await harbor.credential.ids({ account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" })',
    handler: async (ctx, rawArgs) => {
      requireDemoProfile(ctx);
      const args = rawArgs as z.infer<typeof CredentialIdsArgsSchema>;
      const status = await statusFor(ctx, args.account);
      return {
        account: args.account,
        network: "testnet" as const,
        credential_ids:
          status?.accepted === true && !status.expired
            ? [status.credentialId]
            : [],
      };
    },
  },
];
