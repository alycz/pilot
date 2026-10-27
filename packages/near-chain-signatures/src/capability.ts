import type {
  PreparedXrpPayment,
  ReviewBoundXrpPayment,
} from "./types.js";

const preparedPayments = new WeakSet<object>();
const reviewBoundPayments = new WeakSet<object>();

export function registerPreparedPayment<T extends PreparedXrpPayment>(value: T): T {
  preparedPayments.add(value);
  return value;
}

export function assertPreparedPaymentCapability(value: PreparedXrpPayment): void {
  if (!preparedPayments.has(value)) {
    throw new Error(
      "prepared XRP payment must originate from this process's bounded adapter",
    );
  }
}

export function registerReviewBoundPayment<T extends ReviewBoundXrpPayment>(
  value: T,
): T {
  reviewBoundPayments.add(value);
  return value;
}

export function assertReviewBoundPaymentCapability(
  value: ReviewBoundXrpPayment,
): void {
  if (!reviewBoundPayments.has(value)) {
    throw new Error(
      "review-bound XRP payment must originate from this process's bounded adapter",
    );
  }
}
