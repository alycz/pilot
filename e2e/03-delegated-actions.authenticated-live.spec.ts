import { requireLane, test } from "./support";

test("golden 03 validates both delegated transactions and verifies their Delegate fields", async ({
  lane,
}) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Requires an active seven-permission test-network link, funded liquidity, and two authorized ledger mutations; fixture cards are not ledger evidence.",
  );
});
