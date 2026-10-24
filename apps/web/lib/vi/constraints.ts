export interface Ap4mMandateConstraints {
  currency: "USD";
  per_payment_max: string;
  daily_max: string;
  total_max: string;
  payees: string[];
  skus?: string[];
}

export interface ProjectedMandates {
  checkout: Record<string, unknown>;
  payment: Record<string, unknown>;
}

function cents(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`${label} must be exact USD with at most two decimals`);
  }
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the VI integer range`);
  }
  return Number(amount);
}

function unique(values: string[], label: string): string[] {
  if (
    values.length === 0 ||
    values.some((value) => value.length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${label} must contain unique non-empty ids`);
  }
  return [...values];
}

export function projectAp4mConstraints(input: {
  agentPublicJwk: JsonWebKey;
  checkoutDisclosureDigest: string;
  constraints: Ap4mMandateConstraints;
  expiresAt: string;
  notBefore: string;
  owner: string;
  merchantRefs: Array<Record<string, string>>;
  skuRefs: Array<Record<string, string>>;
}): ProjectedMandates {
  if (input.constraints.currency !== "USD") {
    throw new Error("AP4M mandate currency must be USD");
  }
  const payees = unique(input.constraints.payees, "payees");
  const skus = input.constraints.skus && input.constraints.skus.length > 0
    ? unique(input.constraints.skus, "skus")
    : [];
  if (input.merchantRefs.length !== payees.length) {
    throw new Error("Merchant disclosures do not match payees");
  }
  if (input.skuRefs.length !== skus.length) {
    throw new Error("SKU disclosures do not match constraints");
  }
  const publicAgentKey = {
    kty: input.agentPublicJwk.kty,
    crv: input.agentPublicJwk.crv,
    x: input.agentPublicJwk.x,
    y: input.agentPublicJwk.y,
  };
  if (
    publicAgentKey.kty !== "EC" ||
    publicAgentKey.crv !== "P-256" ||
    typeof publicAgentKey.x !== "string" ||
    typeof publicAgentKey.y !== "string" ||
    input.agentPublicJwk.d !== undefined
  ) {
    throw new Error("Prepared mandate agent key must be a public P-256 JWK");
  }
  const confirmation = { jwk: publicAgentKey };
  const checkoutConstraints: Array<Record<string, unknown>> = [
    {
      type: "mandate.checkout.allowed_merchant",
      allowed_merchants: input.merchantRefs,
    },
  ];
  if (skus.length > 0) {
    checkoutConstraints.push({
      type: "mandate.checkout.line_items",
      items: [
        {
          id: "line-1",
          acceptable_items: input.skuRefs,
          quantity: 1,
        },
      ],
    });
  }
  return {
    checkout: {
      vct: "mandate.checkout.open",
      cnf: confirmation,
      constraints: checkoutConstraints,
    },
    payment: {
      vct: "mandate.payment.open",
      cnf: confirmation,
      constraints: [
        {
          type: "payment.amount",
          currency: "USD",
          min: 0,
          max: cents(input.constraints.per_payment_max, "per_payment_max"),
        },
        {
          type: "payment.budget",
          currency: "USD",
          max: cents(input.constraints.total_max, "total_max"),
          pilot_daily_max: cents(input.constraints.daily_max, "daily_max"),
        },
        {
          type: "payment.allowed_payee",
          allowed_payees: input.merchantRefs,
        },
        {
          type: "payment.agent_recurrence",
          frequency: "ON_DEMAND",
          start_date: input.notBefore.slice(0, 10),
          end_date: input.expiresAt.slice(0, 10),
        },
        {
          type: "payment.reference",
          conditional_transaction_id: input.checkoutDisclosureDigest,
        },
      ],
      payment_instrument: { type: "xrpl.ap4m", id: input.owner },
    },
  };
}
