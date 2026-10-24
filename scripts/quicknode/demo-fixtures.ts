import { pathToFileURL } from "node:url";

import { CardEventSchema, WatchdogEventSchema } from "../../packages/contracts/src/index";
import {
  demoQuickNodeFreezeNotice,
  fixtureQuickNodeFreezeNotice,
  fixtureSequence,
} from "../../apps/web/app/chat/fixtures";
import { parseQuickNodeFreezeNotice } from "../../apps/web/components/chat/stream-parts";

const FIXTURE_ACCOUNT = "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK";
const FORBIDDEN_NOTICE_KEYS = new Set([
  "account",
  "delegate",
  "flags",
  "memo",
  "provider",
  "raw",
  "raw_json",
  "tx_type",
]);

export type QuickNodeDemoFixtureReport = Readonly<{
  result: "pass";
  evidence: "local-mock";
  rpc: "quicknode-mock";
  confirmation: "quicknode-mock";
  watch: "quicknode-mock";
  freeze_notice_fields: readonly ["tx_hash", "ledger_index", "network"];
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Verify the exact logged-out QuickNode fixtures without starting Pilot,
 * contacting Harbor, or turning local mock evidence into a live claim.
 */
export function verifyPilotQuickNodeDemoFixtures(): QuickNodeDemoFixtureReport {
  const sequence = fixtureSequence("Swap 80 RLUSD for XRP");
  const validated = sequence.at(-1);
  const parsedCard = CardEventSchema.safeParse(validated);
  assert(parsedCard.success, "logged-out QuickNode card fixture is not contract-valid");
  assert(parsedCard.data.state === "validated", "logged-out QuickNode card is not validated");
  assert(parsedCard.data.trust?.rpc === "quicknode-mock", "fixture must label mock RPC honestly");
  assert(
    parsedCard.data.trust.confirmation?.provider === "quicknode-mock",
    "fixture must label mock webhook confirmation honestly",
  );
  assert(
    parsedCard.data.trust.watch?.provider === "quicknode-mock" &&
      parsedCard.data.trust.watch.status === "watching",
    "fixture must label mock Streams monitoring honestly",
  );

  const selected = fixtureQuickNodeFreezeNotice(
    "Show the QuickNode Streams agent-key freeze demo",
  );
  assert(selected !== undefined, "logged-out QuickNode freeze fixture is not selectable");
  const noticeKeys = Object.keys(selected).sort();
  assert(
    JSON.stringify(noticeKeys) ===
      JSON.stringify(["ledger_index", "network", "tx_hash"]),
    "freeze fixture must expose only the three bounded UI fields",
  );
  assert(
    !noticeKeys.some((key) => FORBIDDEN_NOTICE_KEYS.has(key.toLowerCase())),
    "freeze fixture exposes a forbidden provider field",
  );
  assert(
    /^[A-F0-9]{64}$/.test(selected.tx_hash) &&
      Number.isSafeInteger(selected.ledger_index) &&
      selected.ledger_index >= 0 &&
      selected.network === "testnet",
    "freeze fixture fields are not bounded Testnet identifiers",
  );

  const rawWatchdogEvent = WatchdogEventSchema.parse({
    tx_hash: selected.tx_hash,
    account: FIXTURE_ACCOUNT,
    delegate: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    class: "out_of_band_delegate",
    flags: ["tx_type_not_delegated"],
    ledger_index: selected.ledger_index,
    close_time: "2026-10-21T00:00:00.000Z",
    action: "frozen",
    next_step: "owner_revoke_onledger",
  });
  assert(
    JSON.stringify(parseQuickNodeFreezeNotice(rawWatchdogEvent, FIXTURE_ACCOUNT)) ===
      JSON.stringify(demoQuickNodeFreezeNotice),
    "authenticated watchdog fixture does not project to the bounded demo notice",
  );
  assert(
    parseQuickNodeFreezeNotice(
      rawWatchdogEvent,
      "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    ) === undefined,
    "watchdog fixture must not project for a different authenticated account",
  );

  return {
    result: "pass",
    evidence: "local-mock",
    rpc: "quicknode-mock",
    confirmation: "quicknode-mock",
    watch: "quicknode-mock",
    freeze_notice_fields: ["tx_hash", "ledger_index", "network"],
  };
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isEntrypoint()) {
  try {
    process.stdout.write(`${JSON.stringify(verifyPilotQuickNodeDemoFixtures())}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "fixture verification failed";
    process.stderr.write(`QN-6 Pilot demo fixtures: fail: ${message}\n`);
    process.exitCode = 1;
  }
}
