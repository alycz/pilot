import { NextRequest, NextResponse } from "next/server";

import { getOpenFinanceService } from "@/lib/mastercard/open-finance";

import { summarizeOpenFinance } from "../_lib/handlers";

export const runtime = "nodejs";
export const preferredRegion = "iad1";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return summarizeOpenFinance(request, getOpenFinanceService());
}
