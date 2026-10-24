import { NextResponse } from "next/server";

import { getOpenFinanceService } from "@/lib/mastercard/open-finance";

import { startOpenFinance } from "../_lib/handlers";

export const runtime = "nodejs";
export const preferredRegion = "iad1";

export async function POST(): Promise<NextResponse> {
  return startOpenFinance(getOpenFinanceService());
}
