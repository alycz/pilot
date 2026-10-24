import { requireLane, test } from "./support";

test("golden 04 obtains the complete live Harbor block verdict without submission", async ({
  lane,
}) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Requires an authenticated wallet-bound Harbor session and the seeded FREEMONEY market; fixture policy output is not hosted Harbor evidence.",
  );
});
