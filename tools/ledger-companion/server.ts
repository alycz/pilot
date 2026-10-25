import { createWallet } from "../../packages/wallet/src/index";

import { createLedgerCompanionListener } from "../../apps/web/lib/ledger-companion/listener";
import {
  LEDGER_COMPANION_ORIGIN,
  LEDGER_COMPANION_SPECULOS_ORIGIN,
  createLedgerCompanionService,
  createSpeculosCompanionSigner,
  createSpeculosEmulatorControls,
} from "../../apps/web/lib/ledger-companion/service";

function requiredEnvironment(): Readonly<{ approvedOrigin: string }> {
  if (process.env.PILOT_LEDGER_COMPANION_ENABLED !== "1" ||
    process.env.TEST_LEDGER_SPECULOS !== "1") {
    throw new Error("The local Ledger companion is default-off. Enable both explicit emulator gates.");
  }
  if (process.env.LEDGER_SPECULOS_URL !== LEDGER_COMPANION_SPECULOS_ORIGIN) {
    throw new Error("LEDGER_SPECULOS_URL must be the fixed loopback Speculos origin.");
  }
  if (process.env.SEED_FILE !== undefined) {
    throw new Error("SEED_FILE is forbidden for the hosted companion public-fixture lane.");
  }
  const approvedOrigin = process.env.PILOT_LEDGER_COMPANION_APPROVED_ORIGIN;
  if (approvedOrigin === undefined) throw new Error("A single approved hosted HTTPS origin is required.");
  return { approvedOrigin };
}

const config = requiredEnvironment();
const wallet = createWallet({
  provider: "ledger",
  network: "testnet",
  ledger: { transport: "virtual", virtualBaseUrl: LEDGER_COMPANION_SPECULOS_ORIGIN },
});
const signer = createSpeculosCompanionSigner(wallet);
const service = createLedgerCompanionService({
  approvedOrigin: config.approvedOrigin,
  signer,
  controls: createSpeculosEmulatorControls(),
});
const listener = createLedgerCompanionListener(service);

await listener.start();
console.log(`Pilot Ledger companion ready on ${LEDGER_COMPANION_ORIGIN}/ui`);
console.log("Software emulator · public default test seed only · Testnet signing only · no submission");

async function shutdown() {
  await listener.stop();
  await signer.disconnect();
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
