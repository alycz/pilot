import { requireLane, test } from "./support";

test("golden 01 authenticates, funds, links, and validates DelegateSet on a test ledger", async ({
  lane,
}) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Requires an explicitly authorized test-network signer, faucet/funding handoff, and ledger mutation; this test remains disabled until that live lane is explicitly authorized.",
  );
});
