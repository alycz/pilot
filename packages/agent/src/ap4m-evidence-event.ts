import {
  Ap4mPublicEvidenceSchema,
  Ap4mReceiptSchema,
  type Ap4mPublicEvidence,
  type Ap4mReceipt,
} from "@pilot/contracts";
import { z } from "zod";

export type Ap4mExactEvidenceEvent = {
  receipt: Ap4mReceipt;
  evidence: Ap4mPublicEvidence;
};

export const Ap4mExactEvidenceEventSchema = z
  .object({ receipt: z.unknown(), evidence: z.unknown() })
  .strict()
  .transform(({ receipt: receiptInput, evidence: evidenceInput }, context): Ap4mExactEvidenceEvent => {
    const receiptResult = Ap4mReceiptSchema.safeParse(receiptInput);
    const evidenceResult = Ap4mPublicEvidenceSchema.safeParse(evidenceInput);
    if (!receiptResult.success || !evidenceResult.success) {
      context.addIssue({ code: "custom", message: "AP4M public evidence did not match the shared contract." });
      return z.NEVER;
    }
    const receipt = receiptResult.data as Ap4mReceipt;
    const evidence = evidenceResult.data as Ap4mPublicEvidence;
    if (receipt.scheme !== "exact" || receipt.settlement !== "validated") {
      context.addIssue({ code: "custom", message: "AP4M public evidence requires validated exact settlement." });
    }
    const validation = receipt.merchant_validation;
    if (
      !validation.validated ||
      validation.intentId !== receipt.intent_id ||
      Object.values(validation.checks).some((check) => check !== "pass") ||
      validation.validation_errors.length !== 0
    ) {
      context.addIssue({ code: "custom", message: "AP4M public evidence requires fully passed merchant validation." });
    }
    if (evidence.intent.intentId !== receipt.intent_id) {
      context.addIssue({ code: "custom", message: "AP4M public evidence intent does not match the receipt." });
    }
    if (
      evidence.artifacts[2].digest !== receipt.l3a_digest.toUpperCase() ||
      evidence.artifacts[3].digest !== receipt.l3b_digest.toUpperCase()
    ) {
      context.addIssue({ code: "custom", message: "AP4M public evidence L3 references do not match the receipt." });
    }
    if (!receipt.proof.tx_hash || evidence.artifacts[4].digest !== receipt.proof.tx_hash.toUpperCase()) {
      context.addIssue({ code: "custom", message: "AP4M public evidence payment reference does not match the validated transaction." });
    }
    return { receipt, evidence };
  });
