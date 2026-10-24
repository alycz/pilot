import { describe, expect, it, vi } from "vitest";

import { OpenFinanceService, maskOwnerName, proposedMandateBudget } from "./service";
import { openOpenFinanceSession, sealOpenFinanceSession } from "./session";
import {
  MockOpenFinanceTransport,
  SandboxOpenFinanceTransport,
  createOpenFinanceTransport,
  openFinanceMode,
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
  it("uses documented endpoints and keeps credentials in request headers/body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      { token: "sandbox-token" },
      { id: "customer-1", username: "pilot-test", createdDate: 1 },
      { link: "https://connect.example/link" },
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
});

describe("Open Finance browser session", () => {
  it("round-trips encrypted state and rejects tampering", () => {
    const value = sealOpenFinanceSession(
      { version: 1, customer_id: "customer-1", account_id: "account-1" },
      SESSION_SECRET,
    );
    expect(value).not.toContain("customer-1");
    expect(openOpenFinanceSession(value, SESSION_SECRET)).toEqual({
      version: 1,
      customer_id: "customer-1",
      account_id: "account-1",
    });
    expect(openOpenFinanceSession(`${value}x`, SESSION_SECRET)).toBeNull();
  });
});
