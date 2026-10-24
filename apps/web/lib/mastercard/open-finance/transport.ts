import type {
  OpenFinanceAccount,
  OpenFinanceCustomer,
  OpenFinanceMode,
  OpenFinanceOwner,
  OpenFinanceToken,
  OpenFinanceTransport,
} from "./types";

const DEFAULT_BASE_URL = "https://api.finicity.com";

const MOCK_ACCOUNT: OpenFinanceAccount = {
  id: "mock-checking-001",
  name: "Checking",
  type: "checking",
  balance: 1_250,
  currency: "USD",
  status: "active",
  realAccountNumberLast4: "0042",
};

export class MockOpenFinanceTransport implements OpenFinanceTransport {
  readonly mode = "mock" as const;

  async authenticate(): Promise<OpenFinanceToken> {
    return { token: "mock-open-finance-session" };
  }

  async createTestingCustomer(): Promise<OpenFinanceCustomer> {
    return {
      id: "mock-customer-001",
      username: "pilot-mock-customer",
      createdDate: 1_798_000_000,
    };
  }

  async generateConnectLink(): Promise<{ link: string }> {
    return { link: "/api/mastercard/open-finance/mock-connect" };
  }

  async listAccounts(): Promise<OpenFinanceAccount[]> {
    return [{ ...MOCK_ACCOUNT }];
  }

  async getOwner(): Promise<OpenFinanceOwner> {
    return {
      name: "Jordan Taylor",
      addresses: [{ city: "New York", country: "US" }],
      emails: [{ address: "mock-owner@example.invalid" }],
      phones: [{ number: "+1-555-0100" }],
    };
  }
}

type FetchLike = typeof fetch;
type Environment = Record<string, string | undefined>;

interface SandboxConfig {
  baseUrl: string;
  partnerId: string;
  partnerSecret: string;
  appKey: string;
  fetchImpl: FetchLike;
}

function requireString(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is not configured`);
  return normalized;
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Mastercard Open Finance ${operation} failed with HTTP ${response.status}`);
  }
  return response.json();
}

function asRecord(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Mastercard Open Finance ${operation} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

export class SandboxOpenFinanceTransport implements OpenFinanceTransport {
  readonly mode = "sandbox" as const;

  constructor(private readonly config: SandboxConfig) {}

  private headers(token?: string): HeadersInit {
    return {
      "Content-Type": "application/json",
      "Finicity-App-Key": this.config.appKey,
      ...(token ? { "Finicity-App-Token": token } : {}),
    };
  }

  async authenticate(): Promise<OpenFinanceToken> {
    const response = await this.config.fetchImpl(
      `${this.config.baseUrl}/aggregation/v2/partners/authentication`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          partnerId: this.config.partnerId,
          partnerSecret: this.config.partnerSecret,
        }),
      },
    );
    const data = asRecord(await readJson(response, "authentication"), "authentication");
    return { token: requireString(data.token as string | undefined, "Open Finance token") };
  }

  async createTestingCustomer(token: string): Promise<OpenFinanceCustomer> {
    const username = `pilot-${crypto.randomUUID()}`;
    const response = await this.config.fetchImpl(
      `${this.config.baseUrl}/aggregation/v2/customers/testing`,
      {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({ username }),
      },
    );
    const data = asRecord(await readJson(response, "customer creation"), "customer creation");
    return {
      id: String(data.id),
      username: String(data.username ?? username),
      createdDate: Number(data.createdDate),
    };
  }

  async generateConnectLink(token: string, customerId: string): Promise<{ link: string }> {
    const response = await this.config.fetchImpl(`${this.config.baseUrl}/connect/v2/generate`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({ partnerId: this.config.partnerId, customerId }),
    });
    const data = asRecord(await readJson(response, "Data Connect generation"), "Data Connect generation");
    return { link: requireString(data.link as string | undefined, "Open Finance Data Connect link") };
  }

  async listAccounts(token: string, customerId: string): Promise<OpenFinanceAccount[]> {
    const response = await this.config.fetchImpl(
      `${this.config.baseUrl}/aggregation/v1/customers/${encodeURIComponent(customerId)}/accounts`,
      { method: "POST", headers: this.headers(token), body: "{}" },
    );
    const data = asRecord(await readJson(response, "account aggregation"), "account aggregation");
    if (!Array.isArray(data.accounts)) throw new Error("Open Finance accounts response is invalid");
    return data.accounts.map((account) => {
      const value = asRecord(account, "account aggregation");
      return {
        id: String(value.id),
        name: String(value.name),
        type: String(value.type),
        balance: Number(value.balance),
        currency: String(value.currency),
        status: String(value.status),
        realAccountNumberLast4: String(value.realAccountNumberLast4 ?? ""),
      };
    });
  }

  async getOwner(token: string, customerId: string, accountId: string): Promise<OpenFinanceOwner> {
    const response = await this.config.fetchImpl(
      `${this.config.baseUrl}/aggregation/v3/customers/${encodeURIComponent(customerId)}/accounts/${encodeURIComponent(accountId)}/owner`,
      { method: "GET", headers: this.headers(token) },
    );
    const data = asRecord(await readJson(response, "account owner"), "account owner");
    const owners = Array.isArray(data.holders)
      ? data.holders
      : Array.isArray(data.owners)
        ? data.owners
        : [data];
    const owner = asRecord(owners[0], "account owner");
    return {
      name: requireString(owner.name as string | undefined, "Open Finance owner name"),
      addresses: Array.isArray(owner.addresses) ? owner.addresses : [],
      emails: Array.isArray(owner.emails) ? owner.emails : [],
      phones: Array.isArray(owner.phones) ? owner.phones : [],
    };
  }
}

export function openFinanceMode(env: Environment = process.env): OpenFinanceMode {
  const value = env.MASTERCARD_OF_MODE?.trim() || "mock";
  if (value !== "mock" && value !== "sandbox") {
    throw new Error("MASTERCARD_OF_MODE must be mock or sandbox");
  }
  return value;
}

export function createOpenFinanceTransport(
  env: Environment = process.env,
  fetchImpl: FetchLike = fetch,
): OpenFinanceTransport {
  if (openFinanceMode(env) === "mock") return new MockOpenFinanceTransport();

  return new SandboxOpenFinanceTransport({
    baseUrl: (env.MASTERCARD_OF_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
    partnerId: requireString(env.MASTERCARD_OF_PARTNER_ID, "MASTERCARD_OF_PARTNER_ID"),
    partnerSecret: requireString(env.MASTERCARD_OF_PARTNER_SECRET, "MASTERCARD_OF_PARTNER_SECRET"),
    appKey: requireString(env.MASTERCARD_OF_APP_KEY, "MASTERCARD_OF_APP_KEY"),
    fetchImpl,
  });
}
