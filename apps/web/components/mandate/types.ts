export type MandatePayeeOption = {
  id: string;
  name: string;
};

export type MandateDraft = {
  perPaymentMaxUsd: string;
  dailyMaxUsd: string;
  totalMaxUsd: string;
  payees: string[];
  expiresAt: string;
};

export type MandateChannelPreview = {
  merchantId: string;
  merchantName: string;
  amountDrops: string;
  lockedUntil: string;
};

const USD = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

function cents(value: string, label: string): bigint {
  if (!USD.test(value)) throw new Error(`${label} must be exact USD with at most two decimals.`);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function validateMandateDraft(
  value: MandateDraft,
  options: {
    maximumTotalUsd: string;
    availablePayeeIds: readonly string[];
    now?: Date;
  },
): MandateDraft {
  const perPayment = cents(value.perPaymentMaxUsd, "Per-payment maximum");
  const daily = cents(value.dailyMaxUsd, "Daily maximum");
  const total = cents(value.totalMaxUsd, "Total maximum");
  const proposal = cents(options.maximumTotalUsd, "Open Finance proposal");
  if (perPayment <= 0n || daily <= 0n || total <= 0n) {
    throw new Error("Mandate limits must be greater than zero.");
  }
  if (perPayment > daily || daily > total) {
    throw new Error("Limits must satisfy per-payment ≤ daily ≤ total.");
  }
  if (total > proposal) {
    throw new Error("The total maximum cannot exceed the verified Open Finance proposal.");
  }
  if (value.payees.length === 0 || new Set(value.payees).size !== value.payees.length) {
    throw new Error("Choose at least one unique merchant.");
  }
  const available = new Set(options.availablePayeeIds);
  if (value.payees.some((payee) => !available.has(payee))) {
    throw new Error("The mandate contains an unknown merchant.");
  }
  const expiry = Date.parse(value.expiresAt);
  const now = options.now ?? new Date();
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    throw new Error("Mandate expiry must be in the future.");
  }
  return {
    ...value,
    payees: [...value.payees],
  };
}
