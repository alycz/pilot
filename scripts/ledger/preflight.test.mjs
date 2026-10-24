import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LedgerPreflightError,
  parseCliArguments,
  readEvidence,
  validateLedgerPreflightEvidence,
} from "./preflight.mjs";

const ADDRESS = "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ";
const DELEGATE = "rRajjEbMJdsRKRu2b5PutvKy3wo8p114u";
const OTHER_ADDRESS = "rGRdukvhGdJCgBHX9FUqnw2vndYupSoG2E";
const PERMISSIONS = [
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
];

function fixture(overrides = {}) {
  return {
    version: 2,
    mode: "virtual",
    browser: {
      source: "browser-capability-probe",
      product: "Chrome",
      version: "140.0.7339.214",
      navigator_hid: true,
    },
    device: {
      source: "ledger-device-probe",
      transport: "speculos",
      connected: true,
      app_name: "XRP",
      app_version: "2.8.2",
      account_index: 0,
      address: ADDRESS,
      verified_on_device: true,
    },
    testnet: {
      source: "xrpl-testnet-read",
      network: "testnet",
      address: ADDRESS,
      account_exists: true,
      xrp_balance_drops: "97999988",
      validated: true,
      ledger_index: 9_999_999,
      ledger_hash: "A".repeat(64),
      rlusd_trust_line: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        limit: "10000",
        balance: "0",
        authorized: true,
        frozen: false,
      },
    },
    harbor: {
      source: "harbor-account-status",
      network: "testnet",
      owner: ADDRESS,
      delegate: DELEGATE,
      status: "active",
      permissions: PERMISSIONS,
    },
    speculos: {
      source: "ledger-conformance",
      api_url: "http://127.0.0.1:5000",
      apdu_url: "http://127.0.0.1:9999",
      reachable: true,
      public_default_seed: true,
      conformance: { passed: 10, total: 10 },
    },
    ...overrides,
  };
}

const expected = {
  mode: "virtual",
  accountIndex: 0,
  address: ADDRESS,
  delegate: DELEGATE,
};

describe("Ledger event-day preflight", () => {
  it("passes a cross-bound, fully green Virtual Ledger report", () => {
    const result = validateLedgerPreflightEvidence(fixture(), expected);
    expect(result).toMatchObject({
      ok: true,
      mode: "virtual",
      address: ADDRESS,
      delegate: DELEGATE,
    });
    expect(result.checks.map((check) => check.name)).toEqual([
      "browser",
      "device",
      "testnet",
      "harbor",
      "speculos",
    ]);
  });

  it("accepts a real-device report only with WebHID and on-device verification", () => {
    const report = fixture({
      mode: "real",
      device: { ...fixture().device, transport: "webhid" },
    });
    expect(validateLedgerPreflightEvidence(report, { ...expected, mode: "real" }).ok).toBe(true);
    expect(() => validateLedgerPreflightEvidence(
      { ...report, device: { ...report.device, verified_on_device: false } },
      { ...expected, mode: "real" },
    )).toThrow(/on-device address verification/i);
  });

  it.each([
    ["wrong browser", (report) => { report.browser.product = "Brave"; }, /product must be "Chrome"/i],
    ["no WebHID", (report) => { report.browser.navigator_hid = false; }, /navigator\.hid capability/i],
    ["old app", (report) => { report.device.app_version = "2.8.1"; }, /at least 2\.8\.2/i],
    ["old Chrome", (report) => { report.browser.version = "88.0.0.0"; }, /version 89 or newer/i],
    ["unverified address", (report) => { report.device.verified_on_device = false; }, /on-device address verification/i],
    ["empty XRP balance", (report) => { report.testnet.xrp_balance_drops = "0"; }, /positive canonical number/i],
    ["unvalidated ledger", (report) => { report.testnet.validated = false; }, /validated-ledger evidence/i],
    ["malformed ledger hash", (report) => { report.testnet.ledger_hash = "a".repeat(64); }, /uppercase 64-hex/i],
    ["wrong trust limit", (report) => { report.testnet.rlusd_trust_line.limit = "1000"; }, /RLUSD trust limit/i],
    ["wrong issuer", (report) => { report.testnet.rlusd_trust_line.issuer = ADDRESS; }, /RLUSD issuer/i],
    ["unauthorized line", (report) => { report.testnet.rlusd_trust_line.authorized = false; }, /authorization/i],
    ["frozen line", (report) => { report.testnet.rlusd_trust_line.frozen = true; }, /freeze state/i],
    ["inactive Harbor link", (report) => { report.harbor.status = "revoked"; }, /link status/i],
    ["permission drift", (report) => { report.harbor.permissions = [...PERMISSIONS].reverse(); }, /seven-permission/i],
    ["remote Speculos", (report) => { report.speculos.api_url = "http://localhost:5000"; }, /API URL/i],
    ["non-public seed", (report) => { report.speculos.public_default_seed = false; }, /public default seed/i],
    ["partial conformance", (report) => { report.speculos.conformance.passed = 9; }, /conformance passes/i],
  ])("fails closed for %s", (_name, mutate, message) => {
    const report = structuredClone(fixture());
    mutate(report);
    expect(() => validateLedgerPreflightEvidence(report, expected)).toThrow(message);
  });

  it("cross-binds mode, index, address, Testnet owner and Harbor owner", () => {
    expect(() => validateLedgerPreflightEvidence(fixture(), { ...expected, mode: "real" }))
      .toThrow(/mode does not match/i);
    expect(() => validateLedgerPreflightEvidence(fixture(), { ...expected, accountIndex: 1 }))
      .toThrow(/selected index/i);
    const mismatchedTestnet = fixture();
    mismatchedTestnet.testnet.address = OTHER_ADDRESS;
    expect(() => validateLedgerPreflightEvidence(mismatchedTestnet, expected)).toThrow(/testnet: address/i);
    const mismatchedHarbor = fixture();
    mismatchedHarbor.harbor.owner = OTHER_ADDRESS;
    expect(() => validateLedgerPreflightEvidence(mismatchedHarbor, expected)).toThrow(/harbor: owner/i);
    const mismatchedDelegate = fixture();
    mismatchedDelegate.harbor.delegate = OTHER_ADDRESS;
    expect(() => validateLedgerPreflightEvidence(mismatchedDelegate, expected)).toThrow(/harbor: delegate/i);
  });

  it("rejects a checksum-invalid expected classic address", () => {
    expect(() => validateLedgerPreflightEvidence(fixture(), {
      ...expected,
      address: `${ADDRESS.slice(0, -1)}B`,
    })).toThrow(/canonical XRPL classic address/i);
  });

  it("rejects a missing, malformed or wrong expected event-build delegate", () => {
    expect(() => validateLedgerPreflightEvidence(fixture(), {
      ...expected,
      delegate: undefined,
    })).toThrow(/expected event-build delegate/i);
    expect(() => validateLedgerPreflightEvidence(fixture(), {
      ...expected,
      delegate: `${DELEGATE.slice(0, -1)}B`,
    })).toThrow(/expected event-build delegate/i);
    expect(() => validateLedgerPreflightEvidence(fixture(), {
      ...expected,
      delegate: OTHER_ADDRESS,
    })).toThrow(/harbor: delegate/i);
  });

  it("rejects a missing or malformed Harbor delegate", () => {
    const missing = fixture();
    delete missing.harbor.delegate;
    expect(() => validateLedgerPreflightEvidence(missing, expected)).toThrow(/report shape/i);

    const malformed = fixture();
    malformed.harbor.delegate = `${DELEGATE.slice(0, -1)}B`;
    expect(() => validateLedgerPreflightEvidence(malformed, expected)).toThrow(/canonical XRPL classic address/i);
  });

  it("rejects extra fields so reports cannot carry credentials or raw provider data", () => {
    const report = fixture();
    report.testnet.raw_response = { secret: "not allowed" };
    expect(() => validateLedgerPreflightEvidence(report, expected)).toThrow(/report shape/i);
  });

  it("parses only the explicit bounded CLI", () => {
    expect(parseCliArguments([
      "--mode", "virtual",
      "--account-index", "0",
      "--address", ADDRESS,
      "--delegate", DELEGATE,
      "--evidence", "report.json",
      "--json",
    ])).toEqual({
      mode: "virtual",
      accountIndex: 0,
      address: ADDRESS,
      delegate: DELEGATE,
      evidence: "report.json",
      json: true,
    });
    expect(() => parseCliArguments(["--discover"])).toThrow(/unknown argument/i);
    expect(() => parseCliArguments([
      "--mode", "virtual",
      "--account-index", "0",
      "--address", ADDRESS,
      "--evidence", "report.json",
    ])).toThrow(/--delegate is required/i);
  });

  it("refuses oversized and malformed evidence files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ledger-preflight-"));
    const malformed = join(directory, "malformed.json");
    const oversized = join(directory, "oversized.json");
    await writeFile(malformed, "{", "utf8");
    await writeFile(oversized, "x".repeat(32 * 1024 + 1), "utf8");
    await expect(readEvidence(malformed)).rejects.toThrow(/not valid JSON/i);
    await expect(readEvidence(oversized)).rejects.toThrow(/between 1 and 32768 bytes/i);
  });

  it("uses sanitized errors with a named failing check", () => {
    try {
      validateLedgerPreflightEvidence({ ...fixture(), unknown: true }, expected);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerPreflightError);
      expect(error.check).toBe("evidence");
      expect(error.message).not.toContain("unknown");
    }
  });
});
