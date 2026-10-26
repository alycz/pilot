import { describe, expect, it, vi } from "vitest";

import { ops } from "../src/ops/near-intents";

const PRINCIPAL = "approval-gateway";
const configured = {
  HARBOR_NEAR_INTENTS_OWNER_FUNDED_RECONCILE_ENABLED: "true",
  HARBOR_NEAR_INTENTS_OWNER_FUNDED_RESERVE_ENABLED: "true",
  HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED: "true",
  HARBOR_NEAR_INTENTS_STATUS_ENABLED: "true",
  HARBOR_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE: "near-native-to-arbitrum-usdc-v1",
  HARBOR_NEAR_INTENTS_APPROVAL_GATEWAY_PRINCIPAL: PRINCIPAL,
  HARBOR_NEAR_INTENTS_TENANT_ID: "pilot-internal",
  HARBOR_NEAR_INTENTS_NEAR_RPC_URL: "https://rpc.mainnet.near.org",
  HARBOR_NEAR_INTENTS_ARBITRUM_RPC_URL: "https://arb1.arbitrum.io/rpc",
  NEAR_INTENTS_API_KEY: "fixture-key",
  HARBOR_API_KEYS: `${PRINCIPAL}:fixture-secret`,
  MAINNET_EXECUTION: "false",
};

function operation() {
  const found = ops.find((candidate) => candidate.name === "near.intents.owner-funded.reconcile");
  if (!found) throw new Error("missing owner-funded reconciliation operation");
  return found;
}

describe("near.intents.owner-funded.reconcile admission", () => {
  it("is present but default-off before parsing caller input", async () => {
    await expect(operation().handler({ principal: PRINCIPAL, env: {}, db: {} }, {}))
      .rejects.toMatchObject({ code: "OWNER_FUNDED_RECONCILE_DISABLED" });
  });

  it("requires the exact configured gateway principal", async () => {
    await expect(operation().handler({
      principal: "other-principal",
      env: configured,
      db: { prepare: vi.fn(), batch: vi.fn() },
    }, {})).rejects.toMatchObject({ code: "OWNER_FUNDED_RECONCILE_AUTH_REQUIRED" });
  });

  it("rejects unknown or caller-controlled reconciliation fields", async () => {
    await expect(operation().handler({
      principal: PRINCIPAL,
      env: configured,
      db: { prepare: vi.fn(), batch: vi.fn() },
    }, {
      stage: "settlement",
      rpc_url: "https://attacker.invalid",
      destination_transaction_hash: `0x${"1".repeat(64)}`,
    })).rejects.toMatchObject({ code: "OWNER_FUNDED_RECONCILE_INVALID" });
  });
});
