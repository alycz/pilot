import { createOpenFinanceTransport, OpenFinanceService } from "../../apps/web/lib/mastercard/open-finance/index";

async function main(): Promise<void> {
  const service = new OpenFinanceService(createOpenFinanceTransport());
  const started = await service.start();

  console.log(`Mode: ${started.mode}`);
  console.log(`Customer: ${started.customer_id}`);
  console.log(`Data Connect: ${started.link}`);

  if (started.mode === "sandbox") {
    console.log("Complete FinBank linking in Data Connect, then press Enter.");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  }

  const refreshed = await service.refresh(started.customer_id);
  const summary = await service.summary(
    started.customer_id,
    refreshed.selected_account_id,
    5_000,
  );
  console.log(`Account: ${refreshed.selected_account_id}`);
  console.log(`Owner: ${summary.owner_name_masked}`);
  console.log(`Proposed budget USD: ${summary.proposed_budget_usd}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Open Finance smoke failed");
  process.exitCode = 1;
});
