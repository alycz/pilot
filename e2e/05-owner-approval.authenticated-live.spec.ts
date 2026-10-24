import { requireLane, test } from "./support";

test("golden 05 validates a Devnet vault deposit after owner signing", async ({ lane }) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Blocked: requires a separately authorized, funded Devnet owner wallet and an explicit owner signature. This preparation run must not connect, fund, sign, submit, or claim validated ledger evidence.",
  );
});
