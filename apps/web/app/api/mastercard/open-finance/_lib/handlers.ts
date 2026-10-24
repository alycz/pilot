import { NextRequest, NextResponse } from "next/server";

import {
  OPEN_FINANCE_COOKIE_OPTIONS,
  OPEN_FINANCE_SESSION_COOKIE,
  type OpenFinanceService,
  readOpenFinanceSession,
  sealOpenFinanceSession,
} from "../../../../../lib/mastercard/open-finance";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponse(error: unknown, fallback: string): NextResponse {
  const message = error instanceof Error ? error.message : fallback;
  return noStore(NextResponse.json({ error: message }, { status: 400 }));
}

export async function startOpenFinance(
  service: OpenFinanceService,
): Promise<NextResponse> {
  try {
    const started = await service.start();
    const response = NextResponse.json({
      mode: started.mode,
      label:
        started.mode === "mock"
          ? "Mastercard Open Finance · mock"
          : "Mastercard Open Finance · sandbox",
      link: started.link,
    });
    response.cookies.set(
      OPEN_FINANCE_SESSION_COOKIE,
      sealOpenFinanceSession({ version: 1, customer_id: started.customer_id }),
      OPEN_FINANCE_COOKIE_OPTIONS,
    );
    return noStore(response);
  } catch (error) {
    return errorResponse(error, "Unable to start Mastercard Open Finance");
  }
}

export async function refreshOpenFinance(
  request: NextRequest,
  service: OpenFinanceService,
): Promise<NextResponse> {
  const session = readOpenFinanceSession(request);
  if (!session) {
    return noStore(NextResponse.json({ error: "Open Finance session is unavailable" }, { status: 401 }));
  }
  try {
    const refreshed = await service.refresh(session.customer_id);
    const response = NextResponse.json({
      accounts: refreshed.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        balance: account.balance,
        currency: account.currency,
        status: account.status,
        last4: account.realAccountNumberLast4,
      })),
      selected_account_id: refreshed.selected_account_id,
    });
    response.cookies.set(
      OPEN_FINANCE_SESSION_COOKIE,
      sealOpenFinanceSession({
        ...session,
        account_id: refreshed.selected_account_id,
      }),
      OPEN_FINANCE_COOKIE_OPTIONS,
    );
    return noStore(response);
  } catch (error) {
    return errorResponse(error, "Unable to refresh Mastercard Open Finance accounts");
  }
}

export async function summarizeOpenFinance(
  request: NextRequest,
  service: OpenFinanceService,
): Promise<NextResponse> {
  const session = readOpenFinanceSession(request);
  if (!session?.account_id) {
    return noStore(NextResponse.json({ error: "Refresh accounts before requesting a summary" }, { status: 401 }));
  }
  const dailyCapValue = request.nextUrl.searchParams.get("daily_cap_usd") ?? "5000";
  const dailyCapUsd = Number(dailyCapValue);
  try {
    return noStore(
      NextResponse.json(
        await service.summary(session.customer_id, session.account_id, dailyCapUsd),
      ),
    );
  } catch (error) {
    return errorResponse(error, "Unable to summarize Mastercard Open Finance verification");
  }
}
