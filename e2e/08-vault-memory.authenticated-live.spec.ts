import { requireLane, test } from "./support";

test("golden 08 reads artifacts produced by the authenticated golden run", async ({ lane }) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Blocked: no authorized live run has produced the required owner-scoped journal, trade, reflection, and pending-preference artifacts. Fixture notes must not be presented as persisted ledger evidence.",
  );
});
