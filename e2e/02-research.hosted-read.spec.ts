import { requireLane, test } from "./support";

test("golden 02 obtains a fresh sourced answer from hosted Harbor without proposing an action", async ({
  lane,
}) => {
  requireLane(lane, "hosted-read");
  test.fixme(
    true,
    "Requires an explicitly configured hosted Pilot URL plus a usable model session; the fixture answer is UI-contract evidence, not proof of current venue data.",
  );
});
