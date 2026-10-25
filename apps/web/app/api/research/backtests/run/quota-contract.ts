export type BacktestAccessScope = Readonly<{
  accountScopeId: string;
  sessionScopeId: string;
  network: "testnet" | "devnet";
  sessionExpiresAt: number;
}>;

export class BacktestQuotaError extends Error {
  constructor(
    readonly code: "QUOTA_EXHAUSTED" | "QUOTA_UNAVAILABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BacktestQuotaError";
  }
}

export interface BacktestExternalReadQuota {
  reserve(scope: BacktestAccessScope, now: number): void | Promise<void>;
}
