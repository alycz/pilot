import type { Mandate } from "@pilot/contracts";
import type { MandatePrepareResult } from "@pilot/harbor-client";
import {
  createMandateSigningPlan,
  signMandateSetup,
  type SignOnlyWallet,
  type WalletBatchCapability,
} from "@pilot/wallet/batch";

import {
  bindL2DigestToSetup,
  buildAutonomousL2,
  loadOrCreateDeviceKey,
  sha256Hex,
  type Ap4mMandateConstraints,
  type DeviceKeyStore,
} from "../../lib/vi";

export type OpenFinanceProof = {
  customer_ref_hash: string;
  owner_name_hash: string;
  verified: true;
};

export type IssuedL1 = {
  digest: string;
  l1: string;
};

export type MandateDraft = {
  claimPublicKeys: Array<{ merchant_id: string; public_key: string }>;
  constraints: Ap4mMandateConstraints;
  expiresAt: string;
  l1: string;
  l1Digest: string;
  l2: string;
  l2Digest: string;
  mandateId: string;
  notBefore: string;
  owner: string;
  unsignedBatch: Record<string, unknown>;
  unsignedSequential?: Record<string, unknown>[];
};

export type RegisteredMandate = {
  mandate: Mandate;
  setupTxHashes: string[];
};

export type MandateChannelPreview = {
  amountDrops: string;
  lockedUntil: string;
  merchantId: string;
  merchantName: string;
};

export interface PrepareMandateDependencies {
  issueL1(input: {
    budget_account: string;
    device_public_jwk: JsonWebKey;
    of_verification: OpenFinanceProof;
  }): Promise<IssuedL1>;
  prepare(input: {
    owner: string;
    network: "testnet";
    constraints: Ap4mMandateConstraints;
    payees: string[];
    expires_at: string;
  }): Promise<MandatePrepareResult>;
  crypto?: Crypto;
  deviceKeyStore?: DeviceKeyStore;
  now?: Date;
}

export interface ApproveMandateDependencies {
  register(input: {
    mandate_id: string;
    l1: string;
    l2: string;
    setup_tx_hash: string | string[];
  }): Promise<Mandate>;
  submit(txBlob: string): Promise<{ hash?: string; status: "validated" | "pending" | "failed" }>;
  wallet: SignOnlyWallet;
}

function requireHash(value: string | undefined): string {
  if (!value || !/^[A-Fa-f0-9]{64}$/.test(value)) {
    throw new Error("Harbor did not return a validated setup transaction hash");
  }
  return value.toUpperCase();
}

export async function prepareMandateDraft(
  input: {
    audience: string;
    constraints: Ap4mMandateConstraints;
    expiresAt: string;
    ofVerification: OpenFinanceProof;
    owner: string;
  },
  dependencies: PrepareMandateDependencies,
): Promise<MandateDraft> {
  const cryptoImpl = dependencies.crypto ?? globalThis.crypto;
  const now = dependencies.now ?? new Date();
  const notBefore = now.toISOString();
  const device = await loadOrCreateDeviceKey(
    dependencies.deviceKeyStore,
    cryptoImpl,
  );
  const prepared = await dependencies.prepare({
    owner: input.owner,
    network: "testnet",
    constraints: input.constraints,
    payees: input.constraints.payees,
    expires_at: input.expiresAt,
  });
  const l1 = await dependencies.issueL1({
    budget_account: input.owner,
    device_public_jwk: device.publicJwk,
    of_verification: input.ofVerification,
  });
  const l1Digest = await sha256Hex(l1.l1, cryptoImpl);
  if (l1.digest.toLowerCase() !== l1Digest) {
    throw new Error("Demo Network L1 digest does not match the issued intent");
  }
  const built = await buildAutonomousL2(
    {
      agentPublicJwk: prepared.agent_public_jwk,
      audience: input.audience,
      constraints: input.constraints,
      deviceKeyId: device.kid,
      devicePrivateKey: device.privateKey,
      expiresAt: input.expiresAt,
      l1: l1.l1,
      mandateId: prepared.mandate_id,
      notBefore,
      owner: input.owner,
    },
    { crypto: cryptoImpl, now },
  );
  const bound = await bindL2DigestToSetup(
    {
      unsignedBatch: prepared.unsigned_batch,
      unsignedSequential: prepared.unsigned_sequential,
    },
    built.l2,
    cryptoImpl,
  );
  return {
    claimPublicKeys: prepared.claim_public_keys,
    constraints: input.constraints,
    expiresAt: input.expiresAt,
    l1: l1.l1,
    l1Digest,
    l2: built.l2,
    l2Digest: built.digest,
    mandateId: prepared.mandate_id,
    notBefore,
    owner: input.owner,
    unsignedBatch: bound.unsignedBatch,
    unsignedSequential: bound.unsignedSequential,
  };
}

export async function approveAndRegisterMandate(
  draft: MandateDraft,
  capability: WalletBatchCapability,
  dependencies: ApproveMandateDependencies,
): Promise<RegisteredMandate> {
  const plan = createMandateSigningPlan(capability, {
    unsignedBatch: draft.unsignedBatch,
    unsignedSequential: draft.unsignedSequential,
  });
  const signed = await signMandateSetup(plan, dependencies.wallet);
  const hashes: string[] = [];
  for (const txBlob of signed.signedBlobs) {
    const submitted = await dependencies.submit(txBlob);
    if (submitted.status !== "validated") {
      throw new Error(
        submitted.status === "pending"
          ? "Setup submission is pending or uncertain; Pilot will not retry automatically."
          : "Setup submission failed; Pilot will not retry automatically.",
      );
    }
    hashes.push(requireHash(submitted.hash));
  }
  const mandate = await dependencies.register({
    mandate_id: draft.mandateId,
    l1: draft.l1,
    l2: draft.l2,
    setup_tx_hash: signed.mode === "batch" ? hashes[0]! : hashes,
  });
  if (mandate.status !== "ACTIVE") {
    throw new Error("Harbor did not activate the mandate");
  }
  return { mandate, setupTxHashes: hashes };
}

export function walletBatchCapability(
  provider: "gemwallet" | "crossmark" | "xaman" | "dev",
): WalletBatchCapability {
  // The dev signer is covered by Pilot's Batch tests. Current xrpl-connect
  // adapters expose sign-only but no affirmative Batch capability signal.
  return provider === "dev" ? "supported" : "unsupported";
}

export function mandateChannelPreviews(
  draft: MandateDraft,
  payees: readonly {
    credentialIssuer: string;
    credentialTypeHex: string;
    id: string;
    name: string;
    xrplAddress: string;
  }[],
): MandateChannelPreview[] {
  const raw = draft.unsignedBatch.RawTransactions;
  if (
    draft.unsignedBatch.TransactionType !== "Batch" ||
    draft.unsignedBatch.Account !== draft.owner ||
    draft.unsignedBatch.Flags !== 0x0001_0000 ||
    !Array.isArray(raw)
  ) {
    throw new Error("Prepared Batch does not match the mandate owner or atomic setup mode");
  }
  const batchTransactions = raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Prepared Batch contains a malformed inner transaction");
    }
    const transaction = (entry as { RawTransaction?: unknown }).RawTransaction;
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
      throw new Error("Prepared Batch contains a malformed inner transaction");
    }
    return transaction as Record<string, unknown>;
  });
  const lockedUntil = new Date(
    Date.parse(draft.expiresAt) + 24 * 60 * 60 * 1_000,
  ).toISOString();
  const expectedCancelAfter =
    Math.floor(Date.parse(draft.expiresAt) / 1_000) - 946_684_800 + 86_400;
  const claims = new Map(
    draft.claimPublicKeys.map(({ merchant_id, public_key }) => [merchant_id, public_key]),
  );
  const expectedAmountDrops = (() => {
    const [whole, fraction = ""] = draft.constraints.total_max.split(".");
    return (BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
  })();
  const expectedCredential = payees.find(
    ({ id }) => id === draft.constraints.payees[0],
  );
  if (
    !expectedCredential ||
    payees.some(
      (payee) =>
        draft.constraints.payees.includes(payee.id) &&
        (payee.credentialIssuer !== expectedCredential.credentialIssuer ||
          payee.credentialTypeHex !== expectedCredential.credentialTypeHex),
    )
  ) {
    throw new Error("Selected merchants do not share one AP4M credential");
  }
  const validateSetup = (
    transactions: readonly Record<string, unknown>[],
    mode: "batch" | "sequential",
  ): Record<string, unknown>[] => {
    if (
      transactions.length !== draft.constraints.payees.length + 1 ||
      transactions[0]?.TransactionType !== "CredentialAccept" ||
      transactions[0]?.Account !== draft.owner ||
      transactions[0]?.Issuer !== expectedCredential.credentialIssuer ||
      transactions[0]?.CredentialType !== expectedCredential.credentialTypeHex
    ) {
      throw new Error(`Prepared ${mode} setup has the wrong credential or channel count`);
    }
    if (
      mode === "batch" &&
      transactions.some(
        (transaction) =>
          transaction.Account !== draft.owner ||
          transaction.Flags !== 0x4000_0000 ||
          transaction.Fee !== "0" ||
          transaction.SigningPubKey !== "",
      )
    ) {
      throw new Error("Prepared Batch has invalid inner signing fields");
    }
    const channels = transactions.slice(1);
    channels.forEach((channel, index) => {
      const merchantId = draft.constraints.payees[index]!;
      const merchant = payees.find(({ id }) => id === merchantId);
      const publicKey = claims.get(merchantId);
      if (
        !merchant ||
        !publicKey ||
        channel.TransactionType !== "PaymentChannelCreate" ||
        channel.Account !== draft.owner ||
        channel.Destination !== merchant.xrplAddress ||
        channel.PublicKey !== publicKey ||
        channel.SettleDelay !== 3_600 ||
        channel.CancelAfter !== expectedCancelAfter ||
        channel.Amount !== expectedAmountDrops
      ) {
        throw new Error(`Prepared ${mode} channel does not match merchant ${merchantId}`);
      }
    });
    return channels;
  };
  const channels = validateSetup(batchTransactions, "batch");
  if (draft.unsignedSequential) {
    const sequentialChannels = validateSetup(
      draft.unsignedSequential,
      "sequential",
    );
    if (
      draft.unsignedSequential[0]?.Issuer !== batchTransactions[0]?.Issuer ||
      draft.unsignedSequential[0]?.CredentialType !==
        batchTransactions[0]?.CredentialType
    ) {
      throw new Error("Prepared sequential credential does not match the Batch");
    }
    const transactionFields = [
      "TransactionType",
      "Account",
      "Destination",
      "Amount",
      "SettleDelay",
      "PublicKey",
      "CancelAfter",
    ] as const;
    sequentialChannels.forEach((channel, index) => {
      if (
        transactionFields.some(
          (field) => channel[field] !== channels[index]?.[field],
        )
      ) {
        throw new Error("Prepared sequential channel does not match the Batch");
      }
    });
  }
  return draft.constraints.payees.map((merchantId, index) => ({
    amountDrops: channels[index]!.Amount as string,
    lockedUntil,
    merchantId,
    merchantName: payees.find((payee) => payee.id === merchantId)!.name,
  }));
}
