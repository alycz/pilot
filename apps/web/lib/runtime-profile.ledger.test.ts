import { describe, expect, it } from "vitest";

import { PILOT_ISOLATED_BUILD_MARKER } from "@pilot/wallet/isolation-profile";

import { resolveProfileLedgerConfig } from "./runtime-profile";

const localRequest = new Request("http://127.0.0.1:3014/api/config/public");
const hostedRequest = new Request("https://pilot.example/api/config/public");

const local = {
  EXEC_NETWORK: "testnet",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet",
} as const;

describe("resolveProfileLedgerConfig", () => {
  it("defaults local testnet profiles to WebHID at account index zero", () => {
    expect(resolveProfileLedgerConfig(local, localRequest)).toEqual({
      enabled: true,
      transports: ["webhid"],
      defaultAccountIndex: 0,
    });
  });

  it.each([
    ["local-wallet", "testnet", "http://127.0.0.1:3014/api/config/public"],
    ["local-wallet", "devnet", "http://127.0.0.1:3014/api/config/public"],
    ["local-wallet-isolated-v1", "testnet", "http://127.0.0.2:3014/api/config/public"],
    ["local-wallet-isolated-v1", "devnet", "http://127.0.0.2:3014/api/config/public"],
  ] as const)(
    "enables both transports for local profile %s on %s",
    (profile, network, requestUrl) => {
      expect(resolveProfileLedgerConfig({
        EXEC_NETWORK: network,
        LEDGER_MODE: "webhid+virtual",
        LEDGER_SPECULOS_URL: "http://127.0.0.1:5000",
        NEXT_PUBLIC_PILOT_BUILD_MARKER: profile === "local-wallet-isolated-v1"
          ? PILOT_ISOLATED_BUILD_MARKER
          : undefined,
        PILOT_DEPLOYMENT_PROFILE: profile,
      }, new Request(requestUrl))).toMatchObject({
        enabled: true,
        transports: ["webhid", "virtual"],
      });
    },
  );

  it("enables the virtual transport only for the exact local upstream", () => {
    expect(resolveProfileLedgerConfig({
      ...local,
      LEDGER_MODE: "webhid+virtual",
      LEDGER_SPECULOS_URL: "http://127.0.0.1:5000",
      LEDGER_DEFAULT_ACCOUNT_INDEX: "2",
    }, localRequest)).toEqual({
      enabled: true,
      transports: ["webhid", "virtual"],
      defaultAccountIndex: 2,
      speculosUpstream: "http://127.0.0.1:5000",
    });
  });

  it("supports an explicit local off mode", () => {
    expect(resolveProfileLedgerConfig({ ...local, LEDGER_MODE: "off" }, localRequest)).toEqual({
      enabled: false,
      transports: [],
      defaultAccountIndex: 0,
    });
  });

  it("keeps virtual disabled until a local Speculos upstream is configured", () => {
    expect(resolveProfileLedgerConfig({
      ...local,
      LEDGER_MODE: "webhid+virtual",
    }, localRequest)).toEqual({
      enabled: true,
      transports: ["webhid"],
      defaultAccountIndex: 0,
    });
  });

  it("keeps Ledger disabled on hosted profiles", () => {
    expect(resolveProfileLedgerConfig({
      EXEC_NETWORK: "testnet",
      LEDGER_MODE: "webhid",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    }, hostedRequest)).toEqual({
      enabled: false,
      transports: [],
      defaultAccountIndex: 0,
    });
  });

  it.each([undefined, "off", "webhid", "webhid+virtual"])(
    "keeps hosted mode %s disabled without a Speculos upstream",
    (mode) => {
      expect(resolveProfileLedgerConfig({
        EXEC_NETWORK: "testnet",
        LEDGER_MODE: mode,
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
      }, hostedRequest)).toMatchObject({ enabled: false, transports: [] });
    },
  );

  it("refuses a Speculos upstream on hosted profiles", () => {
    expect(() => resolveProfileLedgerConfig({
      EXEC_NETWORK: "testnet",
      LEDGER_MODE: "webhid+virtual",
      LEDGER_SPECULOS_URL: "http://127.0.0.1:5000",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    }, hostedRequest)).toThrow("PILOT_HOSTED_LEDGER_SPECULOS_FORBIDDEN");
  });

  it.each([
    [{ ...local, LEDGER_MODE: "virtual" }, "PILOT_INVALID_LEDGER_MODE"],
    [{ ...local, LEDGER_DEFAULT_ACCOUNT_INDEX: "10" }, "PILOT_INVALID_LEDGER_ACCOUNT_INDEX"],
    [{ ...local, EXEC_NETWORK: "mainnet" }, "PILOT_LEDGER_TEST_NETWORK_REQUIRED"],
    [{ ...local, LEDGER_MODE: "webhid+virtual", LEDGER_SPECULOS_URL: "http://localhost:5000" }, "PILOT_INVALID_LEDGER_SPECULOS_URL"],
  ] as const)("fails closed for invalid Ledger configuration", (environment, error) => {
    expect(() => resolveProfileLedgerConfig(environment, localRequest)).toThrow(error);
  });

  it("rejects a non-local request for a local profile", () => {
    expect(() => resolveProfileLedgerConfig(local, hostedRequest)).toThrow(
      "PILOT_LOCAL_REQUEST_REQUIRED",
    );
  });
});
