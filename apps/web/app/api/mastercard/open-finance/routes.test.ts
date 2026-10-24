import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

function request(
  path: string,
  cookie?: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`https://pilot.example${path}`, {
    method: "POST",
    headers: {
      origin: "https://pilot.example",
      ...(cookie ? { cookie: `${OPEN_FINANCE_SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {}),
      ...headers,
    },
  });
}

describe("Mastercard Open Finance routes", () => {
  beforeAll(() => {
    process.env.SESSION_SECRET =
      "test-session-secret-that-is-longer-than-thirty-two-characters";
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
  });

  it("runs the complete mock flow without exposing raw PII", async () => {
    const service = new OpenFinanceService(new MockOpenFinanceTransport());
    const start = await startOpenFinance(
      request("/api/mastercard/open-finance/start"),
      service,
    );
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

  it("rejects missing and cross-origin mutation requests before side effects", async () => {
    const service = new OpenFinanceService(new MockOpenFinanceTransport());
    const start = vi.spyOn(service, "start");
    const refresh = vi.spyOn(service, "refresh");

    const missingOrigin = new NextRequest(
      "https://pilot.example/api/mastercard/open-finance/start",
      { method: "POST" },
    );
    expect((await startOpenFinance(missingOrigin, service)).status).toBe(403);
    expect(start).not.toHaveBeenCalled();

    expect((await startOpenFinance(request(
      "/api/mastercard/open-finance/start",
      undefined,
      { origin: "https://attacker.example" },
    ), service)).status).toBe(403);
    expect(start).not.toHaveBeenCalled();

    expect((await refreshOpenFinance(request(
      "/api/mastercard/open-finance/refresh",
      undefined,
      { origin: "https://attacker.example" },
    ), service)).status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("derives hosted authority from configuration, never request or forwarded hosts", async () => {
    const service = new OpenFinanceService(new MockOpenFinanceTransport());
    const start = vi.spyOn(service, "start");
    const internalUrl = "http://next-internal:3000/api/mastercard/open-finance/start";

    const spoofedAuthority = new NextRequest(internalUrl, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    expect((await startOpenFinance(spoofedAuthority, service)).status).toBe(403);
    expect(start).not.toHaveBeenCalled();

    const configuredAuthority = new NextRequest(internalUrl, {
      method: "POST",
      headers: {
        origin: "https://pilot.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    });
    expect((await startOpenFinance(configuredAuthority, service)).status).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("serves the mandatory mock Data Connect banner", async () => {
    const response = mockConnect();
    expect(await response.text()).toContain(
      "MOCK — Mastercard Data Connect appears here with sandbox keys",
    );
  });
});
