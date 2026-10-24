import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import {
  OPEN_FINANCE_SESSION_COOKIE,
  MockOpenFinanceTransport,
  OpenFinanceService,
} from "../../../../lib/mastercard/open-finance";

import {
  refreshOpenFinance,
  startOpenFinance,
  summarizeOpenFinance,
} from "./_lib/handlers";
import { GET as mockConnect } from "./mock-connect/route";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`https://pilot.example${path}`, {
    headers: cookie ? { cookie: `${OPEN_FINANCE_SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {},
  });
}

describe("Mastercard Open Finance routes", () => {
  beforeAll(() => {
    process.env.SESSION_SECRET =
      "test-session-secret-that-is-longer-than-thirty-two-characters";
  });

  it("runs the complete mock flow without exposing raw PII", async () => {
    const service = new OpenFinanceService(new MockOpenFinanceTransport());
    const start = await startOpenFinance(service);
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({
      mode: "mock",
      label: "Mastercard Open Finance · mock",
      link: "/api/mastercard/open-finance/mock-connect",
    });
    const firstCookie = start.cookies.get(OPEN_FINANCE_SESSION_COOKIE)?.value;
    expect(firstCookie).toBeTruthy();
    expect(start.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(start.headers.get("set-cookie")).toMatch(/Secure/i);

    const refresh = await refreshOpenFinance(
      request("/api/mastercard/open-finance/refresh", firstCookie),
      service,
    );
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json();
    expect(refreshed.accounts[0]).toMatchObject({
      name: "Checking",
      balance: 1_250,
      last4: "0042",
    });
    const secondCookie = refresh.cookies.get(OPEN_FINANCE_SESSION_COOKIE)?.value;

    const summary = await summarizeOpenFinance(
      request("/api/mastercard/open-finance/summary?daily_cap_usd=5000", secondCookie),
      service,
    );
    const body = await summary.json();
    expect(summary.status).toBe(200);
    expect(body).toMatchObject({
      label: "Mastercard Open Finance · mock",
      owner_name_masked: "J••••• T•••••",
      customer_ref_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposed_budget_usd: 25,
    });
    expect(Object.keys(body)).toEqual([
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
    expect(JSON.stringify(body)).not.toContain("Jordan Taylor");
    expect(JSON.stringify(body)).not.toContain("mock-owner@example.invalid");
    expect(JSON.stringify(body)).not.toContain("mock-customer-001");
    expect(JSON.stringify(body)).not.toContain("mock-checking-001");
  });

  it("binds refresh and summary to the encrypted session", async () => {
    const service = new OpenFinanceService(new MockOpenFinanceTransport());
    expect((await refreshOpenFinance(request("/refresh"), service)).status).toBe(401);
    expect((await summarizeOpenFinance(request("/summary"), service)).status).toBe(401);
  });

  it("serves the mandatory mock Data Connect banner", async () => {
    const response = mockConnect();
    expect(await response.text()).toContain(
      "MOCK — Mastercard Data Connect appears here with sandbox keys",
    );
  });
});
