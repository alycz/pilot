import { requireLane, test } from "./support";

test("golden 05 validates a Devnet vault deposit after owner signing", async ({ lane }) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Blocked: requires a separately authorized, funded Devnet owner wallet and an explicit owner signature. This test must remain disabled unless an operator explicitly authorizes connecting, funding, signing, and submitting in the configured test environment.",
  );
});
