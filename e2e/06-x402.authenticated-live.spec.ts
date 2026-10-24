import { requireLane, test } from "./support";

test("golden 06 completes a paid premium comparison and records spend", async ({ lane }) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Blocked: the hosted Harbor Worker cannot reach a merchant bound to localhost. No fake 402 settlement, transaction hash, successful result, budget spend, or journal entry may substitute for a reachable merchant and validated Testnet payment.",
  );
});
