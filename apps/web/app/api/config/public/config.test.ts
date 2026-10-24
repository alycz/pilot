import { describe, expect, it } from "vitest";

import { resolvePublicPilotConfig } from "./config";

describe("public Ledger config", () => {
  it("exposes transport capability without exposing the upstream", async () => {
    const config = await resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      HARBOR_URL: "http://127.0.0.1:8791",
      HARBOR_MOCK: "1",
      LEDGER_MODE: "webhid+virtual",
      LEDGER_SPECULOS_URL: "http://127.0.0.1:5000",
      LEDGER_DEFAULT_ACCOUNT_INDEX: "0",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
    }, new Request("http://127.0.0.1:3003/api/config/public", {
      headers: { host: "127.0.0.1:3003" },
    }));

    expect(config).toMatchObject({
      ledger: {
        enabled: true,
        transports: ["webhid", "virtual"],
        defaultAccountIndex: 0,
      },
    });
    expect(JSON.stringify(config)).not.toContain("5000");
    expect(JSON.stringify(config)).not.toContain("speculosUpstream");
  });
});
