// Ledger XRP conformance run against a FRESH Speculos (blind signing off, default seed or SEED_FILE).
// Proves every transaction shape Pilot asks an owner to sign. Run with: npx tsx tools/ledger-sim/conformance.mjs
// (plain `node` cannot load the DMK's ESM build: ERR_UNSUPPORTED_DIR_IMPORT; tsx or a bundler can).
import { DeviceManagementKitBuilder, DeviceActionStatus, DeviceModelId } from "@ledgerhq/device-management-kit";
import { speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { SignerXrpBuilder } from "@ledgerhq/device-signer-kit-xrp";
import { encode, encodeForSigning, decode, deriveAddress, verifyKeypairSignature } from "xrpl";
import { firstValueFrom } from "rxjs";
import { speculos } from "./drive.mjs";

const dev = speculos();
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const RLUSD = { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };
const HARBOR_DELEGATE = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"; // any valid address; Harbor supplies the real one
// Pilot's onboarding grant (apps/web/components/onboarding/onboarding-flow.tsx DEFAULT_PERMISSIONS).
// PermissionValue = TransactionType code + 1; this is what the device shows as "Unknown [n] | value".
const GRANT = { OfferCreate: 8, OfferCancel: 9, TrustSet: 21, AMMDeposit: 37, AMMWithdraw: 38, EscrowFinish: 3, CheckCash: 18 };

function action(obs) {
  return new Promise((resolve, reject) => obs.subscribe({
    next: (s) => {
      if (s.status === DeviceActionStatus.Completed) resolve(s.output);
      else if (s.status === DeviceActionStatus.Error) reject(s.error);
      else if (s.status === DeviceActionStatus.Stopped) reject(new Error("stopped"));
    },
    error: reject,
  }));
}

const dmk = new DeviceManagementKitBuilder()
  .addTransport(speculosTransportFactory(dev.base, false, DeviceModelId.NANO_X))
  .build();
const device = await firstValueFrom(dmk.startDiscovering({}));
const sessionId = await dmk.connect({ device });
const signer = new SignerXrpBuilder({ dmk, sessionId }).build();
const PATH = "44'/144'/0'/0/0";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const cfg = await action(signer.getAppConfig().observable);
check("app config", /^\d+\.\d+\.\d+$/.test(cfg.version), `XRP app ${cfg.version}`);

const { address, publicKey } = await action(signer.getAddress(PATH).observable);
check("address + compressed pubkey", publicKey.length === 66 && deriveAddress(publicKey) === address, address);

const verifyP = action(signer.getAddress("44'/144'/1'/0/0", { checkOnDevice: true }).observable);
const verifyScreens = await dev.review("approve");
const verified = await verifyP;
check("verify address on device", /Verify XRP Address/.test(verifyScreens.join(" ")), `index 1 ${verified.address}`);

async function sign(name, tx, { target = "approve", expect = "signed", mustShow = [] } = {}) {
  const unsigned = { Account: address, Fee: "12", Sequence: 1, LastLedgerSequence: 99999999, ...tx, SigningPubKey: publicKey.toUpperCase() };
  const pending = action(signer.signTransaction(PATH, Buffer.from(encode(unsigned), "hex")).observable);
  const [res, screens] = await Promise.allSettled([pending, dev.review(target)]);
  const shown = (screens.value ?? []).join(" ‖ ");
  const missing = mustShow.filter((m) => !shown.includes(m));
  if (expect === "signed") {
    if (res.status !== "fulfilled") return check(name, false, `rejected ${res.reason?.errorCode ?? res.reason?.message}`);
    const blob = encode({ ...unsigned, TxnSignature: Buffer.from(res.value).toString("hex").toUpperCase() });
    const d = decode(blob);
    // Same verification Pilot's server performs (apps/web/lib/wallet-session.ts).
    const ok = deriveAddress(d.SigningPubKey) === address && verifyKeypairSignature(encodeForSigning(d), d.TxnSignature, d.SigningPubKey);
    check(name, ok && missing.length === 0, missing.length ? `missing on screen: ${missing.join(", ")}` : `${screens.value.length} screens`);
  } else {
    const code = res.status === "rejected" ? String(res.reason?.errorCode ?? "") : "signed";
    check(name, code === expect && missing.length === 0, `got ${code}${missing.length ? `; missing ${missing.join(", ")}` : ""}`);
  }
}

await sign("wallet sign-in challenge (AccountSet + memo)", {
  TransactionType: "AccountSet", Sequence: 0, Fee: "0", LastLedgerSequence: 0,
  Memos: [{ Memo: { MemoType: hex("pilot-wallet-auth-v1"), MemoData: hex("q8ZbXk3JmQ1V0aT9yHn2cWpL6rS4uE7oDgBfKzAiMhY") } }],
}, { mustShow: ["Account Setting", "pilot-wallet-auth-v1"] });

await sign("chat action proof (AccountSet + JSON memo)", {
  TransactionType: "AccountSet", Sequence: 0, Fee: "0", LastLedgerSequence: 0,
  Memos: [{ Memo: { MemoType: hex("pilot-wallet-action-v1"), MemoData: hex(JSON.stringify({ action: "chat", network: "testnet", nonce: "q8ZbXk3JmQ1V0aT9yHn2cWpL6rS4uE7oDgBfKzAiMhY", requestDigest: "A".repeat(64) })) } }],
}, { mustShow: ["pilot-wallet-action-v1"] });

await sign("RLUSD TrustSet", { TransactionType: "TrustSet", LimitAmount: { ...RLUSD, value: "1000" } }, { mustShow: ["Set Trust Line", "RLUSD"] });
await sign("OfferCreate fill-or-kill", { TransactionType: "OfferCreate", TakerGets: "75000000", TakerPays: { ...RLUSD, value: "100" }, Flags: 0x00040000 }, { mustShow: ["Create Offer", "Fill or Kill"] });

const delegateSet = { TransactionType: "DelegateSet", Authorize: HARBOR_DELEGATE, Permissions: Object.values(GRANT).map((v) => ({ Permission: { PermissionValue: v } })) };
await sign("DelegateSet with blind signing OFF is refused", delegateSet, { expect: "6985", mustShow: ["Blind signing must"] });
await dev.setBlindSigning(true);
await sign("DelegateSet with blind signing ON", delegateSet, { mustShow: ["Blind signing ahead", HARBOR_DELEGATE.slice(0, 12), ...Object.values(GRANT).map((v, i) => `Unknown [${i + 1}] | ${v}`)] });
await dev.setBlindSigning(false);

await sign("user rejects", { TransactionType: "TrustSet", LimitAmount: { ...RLUSD, value: "1000" } }, { target: "reject", expect: "6985" });

await dmk.disconnect({ sessionId }).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
