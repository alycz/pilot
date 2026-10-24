// Capture deterministic, text-only XRP app review transcripts from a local Speculos.
// Run with: pnpm tsx tools/ledger-sim/capture-transcripts.mjs
//
// This script intentionally records only screen text. It never writes the public test
// seed, APDUs, unsigned transactions, signatures, or signed blobs.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  DeviceModelId,
} from "@ledgerhq/device-management-kit";
import { SignerXrpBuilder } from "@ledgerhq/device-signer-kit-xrp";
import { speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { encode } from "xrpl";
import { firstValueFrom } from "rxjs";

import { speculos } from "./drive.mjs";

const SPECULOS_URL = process.env.LEDGER_SPECULOS_URL ?? "http://127.0.0.1:5000";
const OUTPUT_DIRECTORY = fileURLToPath(
  new URL("../../apps/web/components/ledger/transcripts/", import.meta.url),
);
const PATH = "44'/144'/0'/0/0";
const VERIFY_PATH = "44'/144'/1'/0/0";
const PUBLIC_DEFAULT_ADDRESS = "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ";
const PUBLIC_DEFAULT_VERIFY_ADDRESS = "rGRdukvhGdJCgBHX9FUqnw2vndYupSoG2E";
const MAX_SCREENS = 80;
const MAX_LINES_PER_SCREEN = 12;
const MAX_LINE_LENGTH = 120;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const parsedSpeculosUrl = new URL(SPECULOS_URL);
if (
  parsedSpeculosUrl.protocol !== "http:" ||
  parsedSpeculosUrl.hostname !== "127.0.0.1" ||
  parsedSpeculosUrl.port !== "5000" ||
  parsedSpeculosUrl.username !== "" ||
  parsedSpeculosUrl.password !== "" ||
  parsedSpeculosUrl.pathname !== "/" ||
  parsedSpeculosUrl.search !== "" ||
  parsedSpeculosUrl.hash !== ""
) {
  throw new Error("Transcript capture only accepts http://127.0.0.1:5000");
}

const dev = speculos(SPECULOS_URL);
const hex = (value) => Buffer.from(value, "utf8").toString("hex").toUpperCase();
const RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};
const HARBOR_DELEGATE = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const GRANT = [8, 9, 21, 37, 38, 3, 18];

function runAction(observable) {
  return new Promise((resolve, reject) =>
    observable.subscribe({
      next(state) {
        if (state.status === DeviceActionStatus.Completed) resolve(state.output);
        if (state.status === DeviceActionStatus.Error) reject(state.error);
        if (state.status === DeviceActionStatus.Stopped) reject(new Error("Device action stopped"));
      },
      error: reject,
    }),
  );
}

function transcript(id, title, rawScreens) {
  if (rawScreens.length === 0 || rawScreens.length > MAX_SCREENS) {
    throw new Error(`${id}: unexpected screen count ${rawScreens.length}`);
  }
  const screens = rawScreens.map((screen, screenIndex) => {
    if (!screen || CONTROL_CHARACTER.test(screen)) {
      throw new Error(`${id}: invalid screen ${screenIndex + 1}`);
    }
    const lines = screen.split(" | ");
    if (
      lines.length > MAX_LINES_PER_SCREEN ||
      lines.some(
        (line) =>
          line.length === 0 ||
          line.length > MAX_LINE_LENGTH ||
          CONTROL_CHARACTER.test(line),
      )
    ) {
      throw new Error(`${id}: invalid line on screen ${screenIndex + 1}`);
    }
    return { lines };
  });
  return { version: 1, id, title, simulated: true, screens };
}

function unsigned(publicKey, address, body) {
  return {
    Account: address,
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 99_999_999,
    ...body,
    SigningPubKey: publicKey.toUpperCase(),
  };
}

async function captureSign(signer, publicKey, address, body, target = "approve") {
  const bytes = Buffer.from(encode(unsigned(publicKey, address, body)), "hex");
  const action = runAction(signer.signTransaction(PATH, bytes).observable);
  const [actionResult, screenResult] = await Promise.allSettled([
    action,
    dev.review(target),
  ]);
  if (screenResult.status === "rejected") throw screenResult.reason;
  if (target === "approve" && actionResult.status === "rejected") {
    throw actionResult.reason;
  }
  if (target === "reject") {
    if (actionResult.status === "fulfilled") {
      throw new Error("Reject flow unexpectedly returned a signature");
    }
    if (String(actionResult.reason?.errorCode ?? "") !== "6985") {
      throw actionResult.reason;
    }
  }
  return screenResult.value;
}

const dmk = new DeviceManagementKitBuilder()
  .addTransport(speculosTransportFactory(SPECULOS_URL, false, DeviceModelId.NANO_X))
  .build();

let sessionId;
try {
  const device = await firstValueFrom(dmk.startDiscovering({}));
  sessionId = await dmk.connect({ device });
  const signer = new SignerXrpBuilder({ dmk, sessionId }).build();
  const { address, publicKey } = await runAction(signer.getAddress(PATH).observable);
  if (address !== PUBLIC_DEFAULT_ADDRESS) {
    throw new Error("Speculos public default account 0 attestation failed");
  }

  await dev.setBlindSigning(false);

  const [verifyAction, verifyReview] = await Promise.allSettled([
    runAction(signer.getAddress(VERIFY_PATH, { checkOnDevice: true }).observable),
    dev.review("approve"),
  ]);
  if (verifyAction.status === "rejected") throw verifyAction.reason;
  if (verifyReview.status === "rejected") throw verifyReview.reason;
  if (verifyAction.value.address !== PUBLIC_DEFAULT_VERIFY_ADDRESS) {
    throw new Error("Speculos public default account 1 attestation failed");
  }
  const verifyScreens = verifyReview.value;

  const captures = [
    [
      "verify-address.json",
      transcript("verify-address", "Verify address", verifyScreens),
    ],
    [
      "sign-in.json",
      transcript(
        "sign-in",
        "Sign in to Pilot",
        await captureSign(signer, publicKey, address, {
          TransactionType: "AccountSet",
          Sequence: 0,
          Fee: "0",
          LastLedgerSequence: 0,
          Memos: [
            {
              Memo: {
                MemoType: hex("pilot-wallet-auth-v1"),
                MemoData: hex("q8ZbXk3JmQ1V0aT9yHn2cWpL6rS4uE7oDgBfKzAiMhY"),
              },
            },
          ],
        }),
      ),
    ],
    [
      "trust-set.json",
      transcript(
        "trust-set",
        "Set the RLUSD trust line",
        await captureSign(signer, publicKey, address, {
          TransactionType: "TrustSet",
          LimitAmount: { ...RLUSD, value: "1000" },
        }),
      ),
    ],
  ];

  await dev.setBlindSigning(true);
  captures.push([
    "delegate-set-blind.json",
    transcript(
      "delegate-set-blind",
      "Grant Harbor seven permissions",
      await captureSign(signer, publicKey, address, {
        TransactionType: "DelegateSet",
        Authorize: HARBOR_DELEGATE,
        Permissions: GRANT.map((value) => ({ Permission: { PermissionValue: value } })),
      }),
    ),
  ]);
  await dev.setBlindSigning(false);

  captures.push(
    [
      "offer-create.json",
      transcript(
        "offer-create",
        "Approve an owner-signed offer",
        await captureSign(signer, publicKey, address, {
          TransactionType: "OfferCreate",
          TakerGets: "75000000",
          TakerPays: { ...RLUSD, value: "100" },
          Flags: 0x0004_0000,
        }),
      ),
    ],
    [
      "reject.json",
      transcript(
        "reject",
        "Reject a request",
        await captureSign(
          signer,
          publicKey,
          address,
          {
            TransactionType: "TrustSet",
            LimitAmount: { ...RLUSD, value: "1000" },
          },
          "reject",
        ),
      ),
    ],
  );

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  for (const [filename, value] of captures) {
    await writeFile(
      new URL(filename, `file://${OUTPUT_DIRECTORY}/`),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
  }
  console.log(`Captured ${captures.length} simulated Ledger transcripts.`);
  for (const [filename, value] of captures) {
    console.log(`${filename}: ${value.screens.length} screens`);
  }
} catch (error) {
  const allowedNames = new Set(["Error", "TypeError", "XrpAppCommandError"]);
  const rawName = typeof error?.name === "string" ? error.name : "";
  const rawCode = String(error?.errorCode ?? "");
  const safeName = allowedNames.has(rawName) ? rawName : "UnknownError";
  const safeCode = /^[A-Z0-9_-]{1,32}$/.test(rawCode) ? rawCode : "UNKNOWN";
  console.error(`Transcript capture failed: ${safeName}:${safeCode}`);
  process.exitCode = 1;
} finally {
  if (sessionId !== undefined) await dmk.disconnect({ sessionId }).catch(() => {});
}
