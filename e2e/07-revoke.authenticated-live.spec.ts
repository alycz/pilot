import { requireLane, test } from "./support";

test("golden 07 revokes delegation and observes approval on the next swap", async ({ lane }) => {
  requireLane(lane, "authenticated-live");
  test.fixme(
    true,
    "Blocked: account.revoke and the owner-signed submission are live mutations requiring transaction-specific authorization. Fixture coverage proves only the post-revocation UI fallback.",
  );
});
