export type OpenFinanceMode = "mock" | "sandbox";

export interface OpenFinanceToken {
  token: string;
}

export interface OpenFinanceCustomer {
  id: string;
  username: string;
  createdDate: number;
}

export interface OpenFinanceAccount {
  id: string;
  name: string;
  type: string;
  balance: number;
  currency: string;
  status: string;
  realAccountNumberLast4: string;
}

export interface OpenFinanceOwner {
  name: string;
  addresses?: unknown[];
  emails?: unknown[];
  phones?: unknown[];
}

export interface OpenFinanceTransport {
  readonly mode: OpenFinanceMode;
  authenticate(): Promise<OpenFinanceToken>;
  createTestingCustomer(token: string): Promise<OpenFinanceCustomer>;
  generateConnectLink(token: string, customerId: string): Promise<{ link: string }>;
  listAccounts(token: string, customerId: string): Promise<OpenFinanceAccount[]>;
  getOwner(
    token: string,
    customerId: string,
    accountId: string,
  ): Promise<OpenFinanceOwner>;
}

export interface OpenFinanceSummary {
  mode: OpenFinanceMode;
  label: "Mastercard Open Finance · mock" | "Mastercard Open Finance · sandbox";
  owner_name_masked: string;
  owner_name_hash: string;
  customer_ref_hash: string;
  balance: number;
  currency: string;
  last4: string;
  proposed_budget_usd: number;
  budget_rule: string;
}
