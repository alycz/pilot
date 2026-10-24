import { NextRequest, NextResponse } from "next/server";

import { getOpenFinanceService } from "@/lib/mastercard/open-finance";

import { refreshOpenFinance } from "../_lib/handlers";

export const runtime = "nodejs";
export const preferredRegion = "iad1";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return refreshOpenFinance(request, getOpenFinanceService());
}
