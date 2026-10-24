import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client, Wallet, isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { WatchdogEventSchema } from "../../src/contracts.ts";
import {
  isEntrypoint,
  parseProbeArgs,
  probeMode,
} from "./q1-coverage.ts";

const TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const HashSchema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/)
  .transform((value) => value.toUpperCase());
const AccountSchema = z.string().refine(isValidClassicAddress);
export const RogueDelegateProofSchema = z
  .object({
    source: z.enum(["standin", "rogue-delegate"]),
    network: z.literal("testnet"),
    tx_hash: HashSchema,
    event: z
      .object({
        tx_hash: HashSchema,
        account: AccountSchema,
        delegate: AccountSchema,
        class: z.literal("out_of_band_delegate"),
        ledger_index: z.number().int().positive(),
        action: z.literal("frozen"),
        next_step: z.literal("owner_revoke_onledger"),
      })
      .strict(),
    link: z
      .object({ account: AccountSchema, frozen: z.literal(true) })
      .strict(),
    next_execute: z
      .object({
        ok: z.literal(false),
        error: z.object({ code: z.literal("link_frozen") }).strict(),
      })
      .strict(),
  })
  .strict();

export type RogueDelegateProof = z.infer<typeof RogueDelegateProofSchema>;

const EnvelopeSchema = z
  .object({ ok: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() })
  .passthrough();
const BuildEnvelopeSchema = EnvelopeSchema.extend({
  ok: z.literal(true),
  data: z.object({ build_id: z.string().min(1) }).passthrough(),
});
const EventsEnvelopeSchema = EnvelopeSchema.extend({
  ok: z.literal(true),
  data: z.array(z.unknown()),
});
const BlockedExecutionEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({ code: z.literal("link_frozen") }).passthrough(),
  })
  .passthrough();
const CleanupEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        owner: AccountSchema,
        network: z.literal("testnet"),
        deleted: z.literal(true),
      })
      .strict(),
  })
  .passthrough();

function harborBase(raw: string): URL {
  const url = new URL(raw);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Rogue-delegate Harbor URL must be a loopback HTTP root");
  }
  return url;
}

function testnetWebsocket(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "wss:" ||
    url.hostname !== "s.altnet.rippletest.net" ||
    (url.port !== "" && url.port !== "51233") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Rogue-delegate XRPL URL must be the public XRPL Testnet websocket");
  }
  return url;
}

async function invokeHarbor(
  base: URL,
  operation: string,
  args: unknown,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(new URL(`api/ops/${operation}`, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`Harbor ${operation} returned HTTP ${response.status}`);
  return response.json();
}

function validatedHash(result: unknown): string {
  const parsed = z
    .object({
      result: z
        .object({
          hash: HashSchema,
          validated: z.literal(true),
          meta: z.object({ TransactionResult: z.literal("tesSUCCESS") }).passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(result);
  return parsed.result.hash;
}

export type RogueDelegateDependencies = Readonly<{
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  fetcher?: typeof fetch;
  createClient?: (url: string) => Client;
  generateWallet?: () => Wallet;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

async function runLiveRogueDelegate(
  harbor: URL,
  xrplUrl: URL,
  dependencies: RogueDelegateDependencies,
): Promise<RogueDelegateProof> {
  const client = (dependencies.createClient ?? ((url) => new Client(url)))(xrplUrl.toString());
  const generateWallet = dependencies.generateWallet ?? (() => Wallet.generate());
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  let registeredOwner: string | undefined;
  await client.connect();
  try {
    const owner = generateWallet();
    const delegate = generateWallet();
    await client.fundWallet(owner);
    await client.fundWallet(delegate);

    // Use TrustSet, one of Harbor's fixed safe delegated permissions, rather
    // than granting Payment to the throwaway delegate. The watchdog proof is
    // about an out-of-band delegated transaction, not a value transfer.
    const delegateSet = await client.autofill({
      TransactionType: "DelegateSet",
      Account: owner.address,
      Authorize: delegate.address,
      Permissions: [{ Permission: { PermissionValue: "TrustSet" } }],
    });
    validatedHash(await client.submitAndWait(owner.sign(delegateSet).tx_blob));

    // Arm exact cleanup before registration. If the local request commits but
    // its response is lost, the finally block still removes the unusable
    // synthetic row rather than leaving it behind.
    registeredOwner = owner.address;
    await invokeHarbor(harbor, "quicknode.test.registerLink", {
      owner: owner.address,
      delegate: delegate.address,
      network: "testnet",
      permissions: ["TrustSet"],
    }, fetcher);
    const build = BuildEnvelopeSchema.parse(await invokeHarbor(
      harbor,
      "tx.trustSet",
      {
        network: "testnet",
        account: owner.address,
        limit_amount: {
          currency: "USD",
          issuer: TESTNET_RLUSD_ISSUER,
          value: "1",
        },
        intent_id: "qn-rogue-delegate-proof",
      },
      fetcher,
    ));

    const rogue = await client.autofill({
      TransactionType: "TrustSet",
      Account: owner.address,
      Delegate: delegate.address,
      LimitAmount: {
        currency: "USD",
        issuer: TESTNET_RLUSD_ISSUER,
        value: "1",
      },
    });
    const txHash = validatedHash(
      await client.submitAndWait(delegate.sign(rogue).tx_blob),
    );

    let event: RogueDelegateProof["event"] | undefined;
    for (let attempt = 0; attempt < 30 && !event; attempt += 1) {
      const response = EventsEnvelopeSchema.parse(await invokeHarbor(
        harbor,
        "quicknode.events",
        { account: owner.address, limit: 20 },
        fetcher,
      ));
      const candidate = response.data.find((value) =>
        value && typeof value === "object" &&
        (value as Record<string, unknown>).tx_hash === txHash);
      const parsed = WatchdogEventSchema.safeParse(candidate);
      if (
        parsed.success &&
        parsed.data.class === "out_of_band_delegate" &&
        parsed.data.action === "frozen" &&
        parsed.data.delegate
      ) {
        event = RogueDelegateProofSchema.shape.event.parse({
          tx_hash: parsed.data.tx_hash,
          account: parsed.data.account,
          delegate: parsed.data.delegate,
          class: parsed.data.class,
          ledger_index: parsed.data.ledger_index,
          action: parsed.data.action,
          next_step: parsed.data.next_step,
        });
      }
      if (!event) await sleep(2_000);
    }
    if (!event) throw new Error("QuickNode watchdog did not freeze the rogue delegate link");

    const blocked = BlockedExecutionEnvelopeSchema.parse(await invokeHarbor(
      harbor,
      "tx.execute",
      {
        build_id: build.data.build_id,
        idempotency_key: `qn-rogue-${txHash.slice(0, 24)}`,
      },
      fetcher,
    ));
    return RogueDelegateProofSchema.parse({
      source: "rogue-delegate",
      network: "testnet",
      tx_hash: txHash,
      event,
      link: { account: owner.address, frozen: true },
      next_execute: { ok: false, error: { code: blocked.error.code } },
    });
  } finally {
    let cleanupError: unknown;
    if (registeredOwner) {
      try {
        const cleanup = CleanupEnvelopeSchema.parse(
          await invokeHarbor(harbor, "quicknode.test.deleteLink", {
            owner: registeredOwner,
            network: "testnet",
          }, fetcher),
        );
        if (cleanup.data.owner !== registeredOwner) {
          throw new Error("QuickNode test-link cleanup owner mismatch");
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    await client.disconnect();
    if (cleanupError) throw cleanupError;
  }
}

export async function runRogueDelegate(
  argv = process.argv.slice(2),
  dependencies: RogueDelegateDependencies = {},
): Promise<RogueDelegateProof> {
  const args = parseProbeArgs(argv);
  const mode = probeMode(args.get("--mode") ?? process.env.QN_MODE);
  let proof: RogueDelegateProof;
  if (mode === "mock") {
    const fixture = resolve(
      args.get("--fixture") ?? "scripts/quicknode/fixtures/q4-watchdog.mock.json",
    );
    proof = RogueDelegateProofSchema.parse(
      JSON.parse(await (dependencies.readFile ?? readFile)(fixture, "utf8")),
    );
    if (proof.source !== "standin") {
      throw new Error("Mock rogue-delegate proof must come from the stand-in");
    }
  } else {
    if (process.env.EXEC_NETWORK !== "testnet") {
      throw new Error("Live rogue-delegate requires EXEC_NETWORK=testnet");
    }
    const rawHarbor = args.get("--harbor-url") ?? process.env.HARBOR_PUBLIC_URL;
    const rawXrpl = args.get("--xrpl-url") ?? process.env.XRPL_TESTNET_URL;
    if (!rawHarbor || !rawXrpl) {
      throw new Error("Live rogue-delegate requires --harbor-url and --xrpl-url");
    }
    proof = await runLiveRogueDelegate(
      harborBase(rawHarbor),
      testnetWebsocket(rawXrpl),
      dependencies,
    );
  }

  const output = args.get("--output");
  if (output) {
    await (dependencies.writeFile ?? writeFile)(
      resolve(output),
      `${JSON.stringify(proof, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return proof;
}

if (isEntrypoint(import.meta.url)) {
  runRogueDelegate().then((proof) => {
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "rogue-delegate proof failed"}\n`,
    );
    process.exitCode = 1;
  });
}
