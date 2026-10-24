import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import { createHarborProvider } from "../src/executor/providers";
import { Ap4mPurchaseError } from "../src/ops/ap4m";

const operation = (error: unknown): OpDef => ({
  name: "ap4m.purchase",
  family: "ap4m",
  summary: "Test the AP4M provider error boundary.",
  tags: ["ap4m"],
  args: z.object({}).strict(),
  returns: "never",
  caveats: [],
  example: "await harbor.ap4m.purchase({})",
  handler: () => {
    throw error;
  },
});

const invoke = (error: unknown) =>
  createHarborProvider(new OpRegistry([operation(error)]), {
    principal: "ap4m-provider-test",
  }).invoke("ap4m.purchase");

describe("AP4M provider error boundary", () => {
  it("surfaces only the reviewed payer_frozen gate with a fixed safe envelope", async () => {
    await expect(
      invoke(
        new Ap4mPurchaseError(
          "disabled payer row contained private diagnostic material",
          "PAYER_FROZEN",
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        service: "ap4m.purchase",
        kind: "error",
        message: "AP4M payer is frozen",
        code: "PAYER_FROZEN",
      },
    });
  });

  it.each([
    "INVALID_PURCHASE",
    "MANDATE_NOT_ACTIVE",
    "POLICY_BLOCKED",
    "IDEMPOTENCY_MISMATCH",
    "PURCHASE_IN_PROGRESS",
    "SETTLEMENT_UNKNOWN",
    "PURCHASE_FAILED",
    "AP4M_NOT_CONFIGURED",
  ] as const)("redacts the AP4M %s error", async (code) => {
    await expect(
      invoke(new Ap4mPurchaseError("sensitive AP4M diagnostic", code)),
    ).resolves.toEqual({
      ok: false,
      error: {
        service: "ap4m.purchase",
        kind: "error",
        message: "Operation failed",
        code: "OPERATION_FAILED",
      },
    });
  });

  it("does not trust a spoofed payer-frozen code from an arbitrary error", async () => {
    await expect(
      invoke(Object.assign(new Error("sensitive spoof"), { code: "PAYER_FROZEN" })),
    ).resolves.toEqual({
      ok: false,
      error: {
        service: "ap4m.purchase",
        kind: "error",
        message: "Operation failed",
        code: "OPERATION_FAILED",
      },
    });
  });
});
