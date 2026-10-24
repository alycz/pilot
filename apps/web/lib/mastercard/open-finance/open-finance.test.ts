import { describe, expect, it, vi } from "vitest";

import { OpenFinanceService, maskOwnerName, proposedMandateBudget } from "./service";
import { openOpenFinanceSession, sealOpenFinanceSession } from "./session";
import {
  MockOpenFinanceTransport,
  SandboxOpenFinanceTransport,
  createOpenFinanceTransport,
  openFinanceMode,
  validatedConnectLink,
} from "./transport";

const SESSION_SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";

describe("Open Finance mock-first transport", () => {
  it("defaults to mock and requires complete configuration only for sandbox", () => {
    expect(openFinanceMode({})).toBe("mock");
    expect(createOpenFinanceTransport({})).toBeInstanceOf(MockOpenFinanceTransport);
    expect(() => createOpenFinanceTransport({ MASTERCARD_OF_MODE: "sandbox" })).toThrow(
      /MASTERCARD_OF_PARTNER_ID/,
    );
    expect(() => openFinanceMode({ MASTERCARD_OF_MODE: "live" })).toThrow(/mock or sandbox/);
  });

  it("caches the app token until the 90-minute refresh boundary", async () => {
    let now = 0;
    const transport = new MockOpenFinanceTransport();
    const authenticate = vi.spyOn(transport, "authenticate");
    const service = new OpenFinanceService(transport, () => now);

    await service.start();
    now = 89 * 60 * 1_000;
    await service.refresh("mock-customer-001");
    expect(authenticate).toHaveBeenCalledTimes(1);

    now = 90 * 60 * 1_000;
    await service.refresh("mock-customer-001");
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("masks owner PII and applies the specified proposed-budget rule", () => {
    expect(maskOwnerName("Jordan Taylor")).toBe("J••••• T•••••");
    expect(proposedMandateBudget(1_250, 5_000)).toBe(25);
    expect(proposedMandateBudget(100_000, 1_000)).toBe(1_000);
    expect(proposedMandateBudget(20, 5_000)).toBe(5);
  });

  it("returns only masked owner data from the mock summary", async () => {
    const service = new OpenFinanceService(new MockOpenFinanceTransport());
    const summary = await service.summary("mock-customer-001", "mock-checking-001", 5_000);
    expect(summary.label).toBe("Mastercard Open Finance · mock");
    expect(summary.owner_name_masked).toBe("J••••• T•••••");
    expect(summary.owner_name_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.customer_ref_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(summary)).toEqual([
      "mode",
      "label",
      "owner_name_masked",
      "owner_name_hash",
      "customer_ref_hash",
      "balance",
      "currency",
      "last4",
      "proposed_budget_usd",
      "budget_rule",
    ]);
    expect(JSON.stringify(summary)).not.toContain("Jordan Taylor");
    expect(JSON.stringify(summary)).not.toContain("mock-owner@example.invalid");
    expect(JSON.stringify(summary)).not.toContain("mock-customer-001");
    expect(JSON.stringify(summary)).not.toContain("mock-checking-001");
  });
});

describe("Open Finance sandbox request shapes", () => {
  it.each([
    "http://api.finicity.com",
    "https://attacker.example",
    "https://user:pass@api.finicity.com",
    "https://api.finicity.com:444",
    "https://api.finicity.com/aggregation",
    "https://api.finicity.com/?redirect=https://attacker.example",
    "https://api.finicity.com/#fragment",
  ])("rejects an unapproved sandbox base URL before credentials can be sent: %s", (baseUrl) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(() => createOpenFinanceTransport({
      MASTERCARD_OF_MODE: "sandbox",
      MASTERCARD_OF_BASE_URL: baseUrl,
      MASTERCARD_OF_PARTNER_ID: "test-partner-id",
      MASTERCARD_OF_PARTNER_SECRET: "test-partner-secret",
      MASTERCARD_OF_APP_KEY: "test-app-key",
    }, fetchImpl)).toThrow(/approved Finicity HTTPS origin/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts only the documented Finicity origin override", () => {
    expect(createOpenFinanceTransport({
      MASTERCARD_OF_MODE: "sandbox",
      MASTERCARD_OF_BASE_URL: "https://api.finicity.com",
      MASTERCARD_OF_PARTNER_ID: "test-partner-id",
      MASTERCARD_OF_PARTNER_SECRET: "test-partner-secret",
      MASTERCARD_OF_APP_KEY: "test-app-key",
    }, vi.fn() as unknown as typeof fetch)).toBeInstanceOf(SandboxOpenFinanceTransport);
  });

  it("uses documented endpoints and keeps credentials in request headers/body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      { token: "sandbox-token" },
      { id: "customer-1", username: "pilot-test", createdDate: 1 },
      { link: "https://connect2.finicity.com/link?customer=customer-1" },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json(responses.shift());
    }) as unknown as typeof fetch;
    const transport = new SandboxOpenFinanceTransport({
      baseUrl: "https://api.finicity.com",
      partnerId: "test-partner-id",
      partnerSecret: "test-partner-secret",
      appKey: "test-app-key",
      fetchImpl,
    });

    const token = await transport.authenticate();
    const customer = await transport.createTestingCustomer(token.token);
    await transport.generateConnectLink(token.token, customer.id);

    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.finicity.com/aggregation/v2/partners/authentication",
      "https://api.finicity.com/aggregation/v2/customers/testing",
      "https://api.finicity.com/connect/v2/generate",
    ]);
    expect(calls[1].init?.headers).toMatchObject({
      "Finicity-App-Key": "test-app-key",
      "Finicity-App-Token": "sandbox-token",
    });
  });

  it.each([
    "http://connect2.finicity.com/link",
    "https://connect2.finicity.com.attacker.example/link",
    "https://user:pass@connect2.finicity.com/link",
    "https://connect2.finicity.com:444/link",
    "https://attacker.example/link",
  ])("rejects an unapproved browser redirect from the provider: %s", (link) => {
    expect(() => validatedConnectLink(link)).toThrow(/Data Connect link/);
  });

  it("accepts only an exact approved Finicity Data Connect HTTPS host", () => {
    expect(validatedConnectLink("https://connect2.finicity.com/link?customer=1"))
      .toBe("https://connect2.finicity.com/link?customer=1");
  });
});

describe("Open Finance browser session", () => {
  it("round-trips encrypted state and rejects tampering", () => {
    const value = sealOpenFinanceSession(
      {
        version: 1,
        customer_id: "customer-1",
        account_id: "account-1",
        wallet_account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        wallet_network: "testnet",
      },
      SESSION_SECRET,
    );
    expect(value).not.toContain("customer-1");
    expect(openOpenFinanceSession(value, SESSION_SECRET)).toEqual({
      version: 1,
      customer_id: "customer-1",
      account_id: "account-1",
      wallet_account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      wallet_network: "testnet",
    });
    expect(openOpenFinanceSession(`${value}x`, SESSION_SECRET)).toBeNull();
  });
});
