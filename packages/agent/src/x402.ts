import type { Envelope } from "@pilot/contracts";
import {
  X402PayResultSchema,
  type X402DeliveredResult,
  type X402PayArgs,
  type X402PayResult,
} from "@pilot/harbor-client";
import { z } from "zod";

export type { X402DeliveredResult } from "@pilot/harbor-client";

export const X402_RESOURCE = "compare" as const;
export const X402_MAX_PRICE_DROPS = "5000" as const;
export const X402_PAY_TO = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr" as const;

const OperationIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/,
  "x402 operation id must be an opaque 8-128 character identifier",
);

export type X402RuntimeMode = "fixture" | "live-local";
export type X402JournalStatus = "failed" | "fixture" | "not_recorded" | "recorded";
export type X402JournalReceipt = {
  recorded: true;
  payment_id: string;
  idempotency_key: string;
};

export type X402PaymentEvent = {
  operation_id: string;
  mode: X402RuntimeMode;
  at: string;
  journal_status: X402JournalStatus;
  journal_error?: string;
  result: X402PayResult;
};

export type X402ModelReceipt =
  | {
      operation: "x402_compare";
      mode: "live-local";
      status: "delivered";
      settlement: "validated";
      journal_status: "recorded" | "recovery_pending";
      merchant_json_available_in_ui: true;
    }
  | {
      operation: "x402_compare";
      mode: "fixture";
      status: "delivered";
      settlement: "fixture_only";
      journal_status: "fixture_only";
      merchant_json_available_in_ui: true;
    }
  | {
      operation: "x402_compare";
      mode: "live-local";
      status: "settlement_unknown";
      settlement: "unconfirmed";
      journal_status: "not_recorded";
      retry_after_seconds: number;
      last_ledger_sequence: number;
      merchant_json_available_in_ui: false;
    };

export const X402PaymentEventSchema = z.object({
  operation_id: OperationIdSchema,
  mode: z.enum(["fixture", "live-local"]),
  at: z.string().datetime({ offset: true }),
  journal_status: z.enum(["failed", "fixture", "not_recorded", "recorded"]),
  journal_error: z.string().trim().min(1).max(500).optional(),
  result: z.custom<X402PayResult>(
    (value) => X402PayResultSchema.safeParse(value).success,
    "invalid x402 result",
  ),
}).strict().superRefine((event, context) => {
  if (event.mode === "fixture" && event.journal_status !== "fixture") {
    context.addIssue({ code: "custom", path: ["journal_status"], message: "fixture results are never journaled" });
  }
  if (event.result.status === "settlement_unknown" && event.journal_status !== "not_recorded") {
    context.addIssue({ code: "custom", path: ["journal_status"], message: "uncertain settlements cannot be journaled as delivered" });
  }
  if (
    event.mode === "live-local" &&
    event.result.status === "delivered" &&
    event.journal_status !== "recorded" &&
    event.journal_status !== "failed"
  ) {
    context.addIssue({ code: "custom", path: ["journal_status"], message: "live delivery requires a durable journal receipt or explicit failure" });
  }
  if ((event.journal_status === "failed") !== (event.journal_error !== undefined)) {
    context.addIssue({ code: "custom", path: ["journal_error"], message: "journal failures require one bounded error" });
  }
});

export type X402Harbor = {
  op(name: "x402.pay", args: X402PayArgs): Promise<Envelope<unknown>>;
};

export type ExecuteX402Options = {
  owner: string;
  network: "testnet";
  operationId: string;
  mode: X402RuntimeMode;
  harbor: X402Harbor;
  emit?: (event: X402PaymentEvent) => void | Promise<void>;
  onDelivered?: (result: X402DeliveredResult) => X402JournalReceipt | Promise<X402JournalReceipt>;
  now?: () => Date;
};

function safeError(error: unknown): string {
  void error;
  return "Durable x402 journal write failed";
}

export function x402IdempotencyKey(operationId: string): string {
  return `pilot-x402:${OperationIdSchema.parse(operationId)}`;
}

/** Fixed projection for model context; merchant-controlled JSON never crosses this boundary. */
export function x402ModelReceipt(event: X402PaymentEvent): X402ModelReceipt {
  if (event.result.status === "delivered") {
    if (event.mode === "fixture") {
      return {
        operation: "x402_compare",
        mode: "fixture",
        status: "delivered",
        settlement: "fixture_only",
        journal_status: "fixture_only",
        merchant_json_available_in_ui: true,
      };
    }
    return {
      operation: "x402_compare",
      mode: "live-local",
      status: "delivered",
      settlement: "validated",
      journal_status: event.journal_status === "recorded"
        ? "recorded"
        : "recovery_pending",
      merchant_json_available_in_ui: true,
    };
  }
  return {
    operation: "x402_compare",
    mode: "live-local",
    status: "settlement_unknown",
    settlement: "unconfirmed",
    journal_status: "not_recorded",
    retry_after_seconds: event.result.retry_after_seconds,
    last_ledger_sequence: event.result.last_ledger_sequence,
    merchant_json_available_in_ui: false,
  };
}

export function bindX402Result(
  request: X402PayArgs,
  value: unknown,
): X402PayResult {
  const result = X402PayResultSchema.parse(value);
  if (
    result.idempotency_key !== request.idempotency_key ||
    result.network !== request.network ||
    (result.status === "settlement_unknown" && (
      result.owner !== request.owner ||
      result.resource !== request.resource
    )) ||
    (result.status === "delivered" && (
      result.owner !== request.owner ||
      result.resource !== request.resource ||
      result.pay_to !== request.pay_to ||
      BigInt(result.amount_drops) !== BigInt(request.max_price_drops) ||
      BigInt(result.fee_drops) > 100n ||
      BigInt(result.amount_drops) + BigInt(result.fee_drops) > 5_100n
    ))
  ) {
    throw new Error("Harbor returned x402 evidence outside the authorized operation binding");
  }
  return result;
}

export async function executeX402Compare(
  options: ExecuteX402Options,
): Promise<X402PaymentEvent> {
  const request: X402PayArgs = {
    owner: options.owner,
    network: options.network,
    resource: X402_RESOURCE,
    max_price_drops: X402_MAX_PRICE_DROPS,
    pay_to: X402_PAY_TO,
    idempotency_key: x402IdempotencyKey(options.operationId),
  };
  let envelope: Envelope<unknown>;
  try {
    envelope = await options.harbor.op("x402.pay", request);
  } catch {
    throw new Error("x402 did not produce validated terminal evidence; recover with the same operation identity");
  }
  if (!envelope.ok) {
    throw new Error("x402 did not produce validated terminal evidence; recover with the same operation identity");
  }
  const result = bindX402Result(request, envelope.data);
  let journalStatus: X402JournalStatus = result.status === "settlement_unknown"
    ? "not_recorded"
    : options.mode === "fixture"
      ? "fixture"
      : "recorded";
  let journalError: string | undefined;
  if (result.status === "delivered" && options.mode === "live-local") {
    if (!options.onDelivered) {
      journalStatus = "failed";
      journalError = "Durable x402 journal adapter is unavailable";
    } else try {
      const receipt = await options.onDelivered(result);
      if (
        receipt.recorded !== true ||
        receipt.payment_id !== result.payment_id ||
        receipt.idempotency_key !== result.idempotency_key
      ) {
        throw new Error("Durable x402 journal receipt did not match the delivered payment");
      }
    } catch (error) {
      journalStatus = "failed";
      journalError = safeError(error);
    }
  }
  const event = X402PaymentEventSchema.parse({
    operation_id: options.operationId,
    mode: options.mode,
    at: (options.now ?? (() => new Date()))().toISOString(),
    journal_status: journalStatus,
    ...(journalError ? { journal_error: journalError } : {}),
    result,
  });
  await options.emit?.(event);
  return event;
}
