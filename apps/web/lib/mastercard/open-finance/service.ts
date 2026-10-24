import { createHash } from "node:crypto";

import { createOpenFinanceTransport, openFinanceMode } from "./transport";
import type {
  OpenFinanceAccount,
  OpenFinanceSummary,
  OpenFinanceTransport,
} from "./types";

const TOKEN_REFRESH_MS = 90 * 60 * 1_000;

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function maskOwnerName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]}${"•".repeat(Math.max(2, Math.min(part.length - 1, 6)))}`)
    .join(" ");
}

export function proposedMandateBudget(checkingBalance: number, dailyCapUsd: number): number {
  if (!Number.isFinite(checkingBalance) || checkingBalance < 0) {
    throw new Error("Checking balance must be a non-negative number");
  }
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0) {
    throw new Error("Daily policy cap must be greater than zero");
  }
  return Math.min(dailyCapUsd, Math.max(5, Math.floor(0.02 * checkingBalance)));
}

function chooseChecking(accounts: OpenFinanceAccount[]): OpenFinanceAccount {
  const account = accounts.find((candidate) => candidate.type.toLowerCase() === "checking");
  if (!account) throw new Error("No checking account was returned by Mastercard Open Finance");
  return account;
}

export class OpenFinanceService {
  private cachedToken?: { value: string; obtainedAt: number };

  constructor(
    readonly transport: OpenFinanceTransport,
    private readonly now: () => number = Date.now,
  ) {}

  private async token(): Promise<string> {
    if (
      this.cachedToken &&
      this.now() - this.cachedToken.obtainedAt < TOKEN_REFRESH_MS
    ) {
      return this.cachedToken.value;
    }
    const authenticated = await this.transport.authenticate();
    this.cachedToken = { value: authenticated.token, obtainedAt: this.now() };
    return authenticated.token;
  }

  async start(): Promise<{ customer_id: string; link: string; mode: "mock" | "sandbox" }> {
    const token = await this.token();
    const customer = await this.transport.createTestingCustomer(token);
    const connect = await this.transport.generateConnectLink(token, customer.id);
    return { customer_id: customer.id, link: connect.link, mode: this.transport.mode };
  }

  async refresh(customerId: string): Promise<{ accounts: OpenFinanceAccount[]; selected_account_id: string }> {
    const accounts = await this.transport.listAccounts(await this.token(), customerId);
    return { accounts, selected_account_id: chooseChecking(accounts).id };
  }

  async summary(
    customerId: string,
    accountId: string,
    dailyCapUsd: number,
  ): Promise<OpenFinanceSummary> {
    const token = await this.token();
    const accounts = await this.transport.listAccounts(token, customerId);
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account || account.type.toLowerCase() !== "checking") {
      throw new Error("The selected checking account is unavailable");
    }
    const owner = await this.transport.getOwner(token, customerId, accountId);
    return {
      mode: this.transport.mode,
      label:
        this.transport.mode === "mock"
          ? "Mastercard Open Finance · mock"
          : "Mastercard Open Finance · sandbox",
      owner_name_masked: maskOwnerName(owner.name),
      owner_name_hash: hashIdentifier(owner.name.trim().toLowerCase()),
      customer_ref_hash: hashIdentifier(customerId),
      balance: account.balance,
      currency: account.currency,
      last4: account.realAccountNumberLast4,
      proposed_budget_usd: proposedMandateBudget(account.balance, dailyCapUsd),
      budget_rule: "min(policy.daily_cap_usd, max(5, floor(0.02 × checking_balance)))",
    };
  }
}

let sharedService: OpenFinanceService | undefined;
let sharedMode: "mock" | "sandbox" | undefined;

export function getOpenFinanceService(): OpenFinanceService {
  const mode = openFinanceMode();
  if (!sharedService || sharedMode !== mode) {
    sharedService = new OpenFinanceService(createOpenFinanceTransport());
    sharedMode = mode;
  }
  return sharedService;
}
