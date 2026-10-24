import {
  AccountLinkSchema,
  AssetSchema,
  DEFAULT_POLICY,
  EnvelopeSchema,
  ExecResultSchema,
  NetworkSchema,
  PolicySchema,
  TxBuildSchema,
  VenueSchema,
  type ExecResult,
  type Policy,
  type TxBuild,
} from "@pilot/contracts";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";

import {
  HarborHttpError,
  createHarborMcpClient,
  createHarborRestClient,
  type ArgsFor,
  type HarborOpName,
} from "../src/index.js";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const VAULT_ID =
  "B100000000000000000000000000000000000000000000000000000000000001";
const VALID_HASH =
  "C100000000000000000000000000000000000000000000000000000000000002";
const XRP = { currency: "XRP" } as const;
const RLUSD = { currency: "RLUSD", issuer: RLUSD_ISSUER } as const;

const harborUrl = process.env.HARBOR_URL?.trim();
const useLiveHarbor = Boolean(harborUrl) && process.env.HARBOR_MOCK !== "1";
const clientConfig = useLiveHarbor
  ? {
      apiKey: process.env.HARBOR_API_KEY,
      baseUrl: harborUrl,
      mock: false,
    }
  : { mock: true };

type RestClient = ReturnType<typeof createHarborRestClient>;
type UntypedOp = (
  name: HarborOpName,
  args: Record<string, unknown>,
) => Promise<unknown>;

const requiredOps = [
  "venues.list",
  "venues.get",
  "venues.compare",
  "ledger.account.info",
  "ledger.account.lines",
  "ledger.account.objects",
  "ledger.account.tx",
  "dex.book",
  "amm.info",
  "tokens.lookup",
  "yield.options",
  "account.link",
  "account.status",
  "account.revoke",
  "policy.get",
  "policy.set",
  "tx.swap",
  "tx.offer",
  "tx.offerCancel",
  "tx.payment",
  "tx.trustSet",
  "tx.ammDeposit",
  "tx.ammWithdraw",
  "tx.vaultDeposit",
  "tx.vaultWithdraw",
  "tx.simulate",
  "tx.execute",
  "tx.submit",
  "tx.status",
] as const satisfies readonly HarborOpName[];

type MissingRequiredOp = Exclude<HarborOpName, (typeof requiredOps)[number]>;
const allRequiredOpsCovered: [MissingRequiredOp] extends [never] ? true : never =
  true;

const fixtureArgs = {
  "venues.list": {},
  "venues.get": { id: "xrpl-dex-clob" },
  "venues.compare": {
    network: "testnet",
    sell: RLUSD,
    buy: XRP,
    amount: "100",
    side: "sell",
  },
  "ledger.account.info": { account: ACCOUNT, network: "testnet" },
  "ledger.account.lines": { account: ACCOUNT, network: "testnet", limit: 20 },
  "ledger.account.objects": {
    account: ACCOUNT,
    network: "testnet",
    limit: 20,
  },
  "ledger.account.tx": {
    account: ACCOUNT,
    network: "testnet",
    limit: 20,
    forward: false,
  },
  "dex.book": {
    network: "testnet",
    taker_gets: XRP,
    taker_pays: RLUSD,
    limit: 20,
  },
  "amm.info": {
    network: "testnet",
    asset: XRP,
    asset2: RLUSD,
  },
  "tokens.lookup": { network: "testnet", asset: RLUSD },
  "yield.options": { network: "testnet", asset: RLUSD, amount: "500" },
  "account.link": { owner: ACCOUNT, network: "testnet" },
  "account.status": { owner: ACCOUNT, network: "testnet" },
  "account.revoke": { owner: ACCOUNT, network: "testnet" },
  "policy.get": { owner: ACCOUNT, network: "testnet" },
  "policy.set": { owner: ACCOUNT, network: "testnet", policy: DEFAULT_POLICY },
  "tx.swap": {
    account: ACCOUNT,
    network: "testnet",
    sell: RLUSD,
    buy: XRP,
    amount: "100",
    side: "sell",
    max_slippage_bps: 100,
    intent_id: "fixture-swap",
  },
  "tx.offer": {
    account: ACCOUNT,
    network: "testnet",
    sell: XRP,
    buy: RLUSD,
    sell_amount: "2",
    buy_amount: "1",
    intent_id: "fixture-offer",
  },
  "tx.offerCancel": {
    account: ACCOUNT,
    network: "testnet",
    offer_sequence: 41,
    intent_id: "fixture-cancel",
  },
  "tx.payment": {
    account: ACCOUNT,
    network: "testnet",
    to: DESTINATION,
    asset: XRP,
    amount: "1",
    intent_id: "fixture-payment",
  },
  "tx.trustSet": {
    account: ACCOUNT,
    network: "testnet",
    asset: RLUSD,
    limit: "1000",
    intent_id: "fixture-trust",
  },
  "tx.ammDeposit": {
    account: ACCOUNT,
    network: "testnet",
    asset: XRP,
    asset2: RLUSD,
    amount: "2",
    amount2: "1",
    intent_id: "fixture-amm-deposit",
  },
  "tx.ammWithdraw": {
    account: ACCOUNT,
    network: "testnet",
    asset: XRP,
    asset2: RLUSD,
    amount: "1",
    intent_id: "fixture-amm-withdraw",
  },
  "tx.vaultDeposit": {
    account: ACCOUNT,
    network: "devnet",
    vault_id: VAULT_ID,
    asset: XRP,
    amount: "1",
    intent_id: "fixture-vault-deposit",
  },
  "tx.vaultWithdraw": {
    account: ACCOUNT,
    network: "devnet",
    vault_id: VAULT_ID,
    asset: XRP,
    amount: "1",
    intent_id: "fixture-vault-withdraw",
  },
  "tx.simulate": {
    account: ACCOUNT,
    network: "testnet",
    tx_json: {
      TransactionType: "OfferCancel",
      Account: ACCOUNT,
      OfferSequence: 41,
    },
    intent_id: "fixture-simulate",
  },
  "tx.execute": {
    build_id: "build-swap-001",
    idempotency_key: "fixture-execute",
  },
  "tx.submit": { tx_blob: "1200002280000000" },
  "tx.status": { hash: VALID_HASH },
} satisfies { [K in HarborOpName]: ArgsFor<K> };

const JsonObjectSchema = z.record(z.string(), z.unknown());
const MarkerSchema = z.union([z.string(), z.number(), JsonObjectSchema]);
const LedgerAmountSchema = z.union([
  z.string(),
  z
    .object({ currency: z.string(), issuer: z.string(), value: z.string() })
    .strict(),
]);

const VenueComparisonSchema = z
  .object({
    network: NetworkSchema,
    sell: AssetSchema,
    buy: AssetSchema,
    amount: z.string(),
    side: z.enum(["sell", "buy"]),
    routes: z.array(
      z
        .object({
          venue_id: z.string(),
          route: z.enum(["order-book", "amm", "path"]),
          input_amount: z.string(),
          output_amount: z.string(),
          price: z.string(),
          price_impact_bps: z.number().optional(),
          fee: z.string().optional(),
          available: z.boolean(),
          detail: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const AccountInfoSchema = z
  .object({
    account: z.string(),
    ledger_index: z.number(),
    validated: z.boolean(),
    account_data: JsonObjectSchema,
  })
  .strict();

const AccountLinesSchema = z
  .object({
    account: z.string(),
    ledger_index: z.number(),
    validated: z.boolean(),
    lines: z.array(
      z
        .object({
          account: z.string(),
          balance: z.string(),
          currency: z.string(),
          limit: z.string(),
          limit_peer: z.string(),
          authorized: z.boolean().optional(),
          freeze: z.boolean().optional(),
        })
        .passthrough(),
    ),
    marker: MarkerSchema.optional(),
  })
  .strict();

const AccountObjectsSchema = z
  .object({
    account: z.string(),
    ledger_index: z.number(),
    validated: z.boolean(),
    account_objects: z.array(JsonObjectSchema),
    marker: MarkerSchema.optional(),
  })
  .strict();

const AccountTransactionsSchema = z
  .object({
    account: z.string(),
    ledger_index_min: z.number(),
    ledger_index_max: z.number(),
    transactions: z.array(
      z
        .object({
          hash: z.string(),
          ledger_index: z.number().optional(),
          validated: z.boolean(),
          tx: JsonObjectSchema,
          meta: JsonObjectSchema.nullable(),
        })
        .strict(),
    ),
    marker: MarkerSchema.optional(),
  })
  .strict();

const DexBookSchema = z
  .object({
    network: NetworkSchema,
    ledger_index: z.number(),
    taker_gets: AssetSchema,
    taker_pays: AssetSchema,
    offers: z.array(
      z
        .object({
          taker_gets: LedgerAmountSchema,
          taker_pays: LedgerAmountSchema,
          quality: z.string(),
        })
        .passthrough(),
    ),
  })
  .strict();

const AmmInfoSchema = z
  .object({
    network: NetworkSchema,
    ledger_index: z.number(),
    amm: JsonObjectSchema,
  })
  .strict();

const TokenLookupSchema = z
  .object({
    network: NetworkSchema,
    asset: AssetSchema,
    name: z.string().optional(),
    symbol: z.string().optional(),
    description: z.string().optional(),
    icon_url: z.string().optional(),
    price_usd: z.string().optional(),
    market_cap_usd: z.string().optional(),
    volume_24h_usd: z.string().optional(),
    flags: z
      .object({
        require_auth: z.boolean(),
        global_freeze: z.boolean(),
        clawback: z.boolean(),
        blackholed: z.boolean(),
      })
      .strict(),
    sources: z.array(z.string()),
  })
  .strict();

const YieldOptionsSchema = z
  .object({
    network: NetworkSchema,
    asset: AssetSchema,
    amount: z.string().optional(),
    options: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(["amm", "vault", "protocol"]),
          venue_id: z.string(),
          network: NetworkSchema,
          asset: AssetSchema,
          asset2: AssetSchema.optional(),
          apr_percent: z.string().optional(),
          apy_percent: z.string().optional(),
          tvl_usd: z.string().optional(),
          risks: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

const TxSubmitSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("validated"),
      hash: z.string(),
      ledger_index: z.number(),
      engine_result: z.string(),
      result: z.enum(["filled", "partial", "resting", "success"]),
      signed_by: z.literal("owner"),
    })
    .strict(),
  z
    .object({
      status: z.literal("pending"),
      hash: z.string(),
      engine_result: z.string(),
      signed_by: z.literal("owner"),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      hash: z.string().optional(),
      engine_result: z.string(),
      detail: z.string(),
    })
    .strict(),
]);

const TxStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_found"), hash: z.string() }).strict(),
  z.object({ status: z.literal("pending"), hash: z.string() }).strict(),
  z
    .object({
      status: z.literal("validated"),
      hash: z.string(),
      ledger_index: z.number(),
      engine_result: z.string(),
      result: z.enum(["filled", "partial", "resting", "success"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      hash: z.string(),
      engine_result: z.string(),
      detail: z.string(),
    })
    .strict(),
]);

const extraResultSchemas: Partial<Record<HarborOpName, z.ZodTypeAny>> = {
  "venues.compare": VenueComparisonSchema,
  "ledger.account.info": AccountInfoSchema,
  "ledger.account.lines": AccountLinesSchema,
  "ledger.account.objects": AccountObjectsSchema,
  "ledger.account.tx": AccountTransactionsSchema,
  "dex.book": DexBookSchema,
  "amm.info": AmmInfoSchema,
  "tokens.lookup": TokenLookupSchema,
  "yield.options": YieldOptionsSchema,
  "tx.submit": TxSubmitSchema,
  "tx.status": TxStatusSchema,
};

const builderOps = new Set<HarborOpName>([
  "tx.swap",
  "tx.offer",
  "tx.offerCancel",
  "tx.payment",
  "tx.trustSet",
  "tx.ammDeposit",
  "tx.ammWithdraw",
  "tx.vaultDeposit",
  "tx.vaultWithdraw",
  "tx.simulate",
]);

const accountOps = new Set<HarborOpName>([
  "account.link",
  "account.status",
  "account.revoke",
]);

function expectOkData<T>(value: unknown): T {
  const envelope = EnvelopeSchema(z.unknown()).parse(value);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) throw new Error(envelope.error.message);
  return envelope.data as T;
}

function expectNoSecretFields(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;

    for (const [key, child] of Object.entries(candidate)) {
      expect(key).not.toMatch(/seed|secret|private|mnemonic|TxnSignature/i);
      visit(child);
    }
  };
  visit(value);
}

function assertOperationData(name: HarborOpName, data: unknown): void {
  if (name === "venues.list") {
    z.array(VenueSchema).parse(data);
  } else if (name === "venues.get") {
    VenueSchema.parse(data);
  } else if (builderOps.has(name)) {
    TxBuildSchema.parse(data);
  } else if (accountOps.has(name)) {
    AccountLinkSchema.parse(data);
  } else if (name === "policy.get" || name === "policy.set") {
    PolicySchema.parse(data);
  } else if (name === "tx.execute") {
    ExecResultSchema.parse(data);
  } else {
    const schema = extraResultSchemas[name];
    expect(schema, `missing result schema for ${name}`).toBeDefined();
    schema!.parse(data);
  }
}

function readExec(value: unknown): ExecResult {
  const envelope = EnvelopeSchema(ExecResultSchema).parse(value);
  return expectOkData<ExecResult>(envelope);
}

async function activateLink(
  client: RestClient,
  owner: string,
  permissions: string[] = ["OfferCreate"],
): Promise<void> {
  expectOkData(
    await client.op("account.link", {
      owner,
      network: "testnet",
      permissions,
    }),
  );
  const active = expectOkData<{ status: string }>(
    await client.op("account.status", { owner, network: "testnet" }),
  );
  expect(active.status).toBe("active");
}

async function buildSwap(
  client: RestClient,
  owner: string,
  amount: string,
  buy: ArgsFor<"tx.swap">["buy"] = XRP,
): Promise<TxBuild> {
  return expectOkData<TxBuild>(
    await client.op("tx.swap", {
      account: owner,
      network: "testnet",
      sell: RLUSD,
      buy,
      amount,
      side: "sell",
      max_slippage_bps: 100,
      intent_id: `swap-${amount}`,
    }),
  );
}

async function executeBuild(
  client: RestClient,
  build: TxBuild,
  idempotencyKey: string,
): Promise<ExecResult> {
  return readExec(
    await client.op("tx.execute", {
      build_id: build.build_id,
      idempotency_key: idempotencyKey,
    }),
  );
}

describe(`Harbor REST contract (${useLiveHarbor ? "live" : "mock"})`, () => {
  const client = createHarborRestClient(clientConfig);
  const op = client.op.bind(client) as unknown as UntypedOp;
  const intentionallyUnusableLiveOps = new Set<HarborOpName>([
    "tx.execute",
    "tx.submit",
  ]);

  it("keeps the transport matrix exhaustive", () => {
    expect(allRequiredOpsCovered).toBe(true);
    expect(new Set(requiredOps).size).toBe(requiredOps.length);
  });

  it.each(requiredOps)(
    "calls %s with valid args and validates its client contract",
    async (name) => {
      const result = await op(name, fixtureArgs[name]);
      const envelope = EnvelopeSchema(z.unknown()).parse(result);
      expectNoSecretFields(envelope);
      if (process.env.HARBOR_API_KEY) {
        expect(JSON.stringify(envelope)).not.toContain(process.env.HARBOR_API_KEY);
      }

      if (
        useLiveHarbor &&
        intentionallyUnusableLiveOps.has(name) &&
        !envelope.ok
      ) {
        return;
      }

      expect(envelope.ok).toBe(true);
      if (!envelope.ok) throw new Error(envelope.error.message);
      assertOperationData(name, envelope.data);
    },
  );
});

describe(`venues.list REST/MCP parity (${useLiveHarbor ? "live" : "mock"})`, () => {
  const rest = createHarborRestClient(clientConfig);
  const mcp = createHarborMcpClient({ ...clientConfig, restClient: rest });

  afterAll(async () => {
    await mcp.close();
  });

  it("returns the exact same contract envelope through both transports", async () => {
    const restResult = await rest.op("venues.list", {});
    const mcpResult = await mcp.execute(
      "return await harbor.venues.list({})",
    );

    EnvelopeSchema(z.array(VenueSchema)).parse(restResult);
    EnvelopeSchema(z.array(VenueSchema)).parse(mcpResult);
    expect(mcpResult).toEqual(restResult);
  });
});

describe.runIf(!useLiveHarbor)("mock argument and catalog behavior", () => {
  it("returns Err rather than throwing for invalid operation arguments", async () => {
    const client = createHarborRestClient({ mock: true });
    const op = client.op.bind(client) as unknown as UntypedOp;
    const result = await op("venues.get", {});
    const envelope = EnvelopeSchema(z.unknown()).parse(result);

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects a forbidden credential word in an argument string value", async () => {
    const client = createHarborRestClient({ mock: true });
    const op = client.op.bind(client) as unknown as UntypedOp;
    const result = await op("venues.get", { id: "contains-secret-material" });
    const envelope = EnvelopeSchema(z.unknown()).parse(result);

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("FORBIDDEN_ARGUMENT");
  });

  it("rejects forbidden delegation permissions and mainnet transaction builds", async () => {
    const client = createHarborRestClient({ mock: true });
    const op = client.op.bind(client) as unknown as UntypedOp;
    const forbidden = await op("account.link", {
      owner: ACCOUNT,
      network: "testnet",
      permissions: ["AccountSet"],
    });
    const mainnet = await op("tx.offerCancel", {
      account: ACCOUNT,
      network: "mainnet",
      offer_sequence: 41,
    });

    for (const result of [forbidden, mainnet]) {
      const envelope = EnvelopeSchema(z.unknown()).parse(result);
      expect(envelope.ok).toBe(false);
    }
  });

  it("honors the requested venue id and rejects an unknown id", async () => {
    const client = createHarborRestClient({ mock: true });
    const amm = expectOkData<{ id: string }>(
      await client.op("venues.get", { id: "xrpl-amm" }),
    );
    const dex = expectOkData<{ id: string }>(
      await client.op("venues.get", { id: "xrpl-dex-clob" }),
    );
    const missing = await client.op("venues.get", { id: "does-not-exist" });

    expect(amm.id).toBe("xrpl-amm");
    expect(dex.id).toBe("xrpl-dex-clob");
    expect(missing.ok).toBe(false);
  });

  it("keeps requested account fields consistent in account info", async () => {
    const client = createHarborRestClient({ mock: true });
    const requestedAccount = DESTINATION;
    const info = expectOkData<{
      account: string;
      account_data: { Account?: unknown };
    }>(
      await client.op("ledger.account.info", {
        account: requestedAccount,
        network: "testnet",
      }),
    );

    expect(info.account).toBe(requestedAccount);
    expect(info.account_data.Account).toBe(requestedAccount);
  });

  it("executes the catalog's JavaScript object-literal example", async () => {
    const mcp = createHarborMcpClient({ mock: true });
    try {
      const catalogSchema = EnvelopeSchema(
        z.array(
          z
            .object({
              name: z.string(),
              family: z.string(),
              summary: z.string(),
              signature: z.string(),
              example: z.string(),
            })
            .strict(),
        ),
      );
      const catalog = catalogSchema.parse(await mcp.search("venues.get"));
      const entries = expectOkData<
        { name: string; example: string }[]
      >(catalog);
      const entry = entries.find(({ name }) => name === "venues.get");

      expect(entry).toBeDefined();
      expect(entry!.example).toMatch(/\{\s*id\s*:/);
      expect(entry!.example).toContain("'");
      const result = await mcp.execute(entry!.example);
      const venue = expectOkData<unknown>(result);
      VenueSchema.parse(venue);
    } finally {
      await mcp.close();
    }
  });

  it("rejects a forbidden credential word anywhere in an MCP script", async () => {
    const mcp = createHarborMcpClient({ mock: true });
    try {
      await expect(
        mcp.execute("return await harbor.venues.get({id:'private-market'})"),
      ).rejects.toThrow(/forbidden credential-related term/i);
    } finally {
      await mcp.close();
    }
  });
});

describe.runIf(!useLiveHarbor)("mock transaction build fidelity", () => {
  const requestedAccount = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

  it("preserves the requested account, assets, and swap amount", async () => {
    const client = createHarborRestClient({ mock: true });
    const build = expectOkData<TxBuild>(
      await client.op("tx.swap", {
        account: requestedAccount,
        network: "testnet",
        sell: RLUSD,
        buy: XRP,
        amount: "12.5",
        side: "sell",
        max_slippage_bps: 75,
      }),
    );

    expect(build.summary.account).toBe(requestedAccount);
    expect(build.tx_json.Account).toBe(requestedAccount);
    expect(build.tx_json.TakerGets).toEqual({ ...RLUSD, value: "12.5" });
    expect(build.tx_json.Flags).toBe(0x0002_0000 | 0x0008_0000);
    expect(Number(build.tx_json.TakerPays) / 1_000_000).toBeCloseTo(
      12.5 / 0.512 / 1.0075,
      6,
    );
  });

  it("uses an IOC limit without tfSell for a fixed-buy swap", async () => {
    const client = createHarborRestClient({ mock: true });
    const build = expectOkData<TxBuild>(
      await client.op("tx.swap", {
        account: requestedAccount,
        network: "testnet",
        sell: RLUSD,
        buy: XRP,
        amount: "2",
        side: "buy",
        max_slippage_bps: 100,
      }),
    );

    expect(build.tx_json.Flags).toBe(0x0002_0000);
    expect(build.tx_json.TakerPays).toBe("2000000");
    expect(build.tx_json.TakerGets).toEqual({
      ...RLUSD,
      value: "1.03424",
    });
  });

  it("preserves limit-offer sides and amounts", async () => {
    const client = createHarborRestClient({ mock: true });
    const build = expectOkData<TxBuild>(
      await client.op("tx.offer", {
        account: requestedAccount,
        network: "testnet",
        sell: XRP,
        buy: RLUSD,
        sell_amount: "2.5",
        buy_amount: "1.25",
      }),
    );

    expect(build.tx_json.Account).toBe(requestedAccount);
    expect(build.tx_json.TakerGets).toBe("2500000");
    expect(build.tx_json.TakerPays).toEqual({ ...RLUSD, value: "1.25" });
  });

  it("preserves payment destination and converts XRP to drops", async () => {
    const client = createHarborRestClient({ mock: true });
    const build = expectOkData<TxBuild>(
      await client.op("tx.payment", {
        account: requestedAccount,
        network: "testnet",
        to: DESTINATION,
        asset: XRP,
        amount: "1.5",
      }),
    );

    expect(build.tx_json.Account).toBe(requestedAccount);
    expect(build.tx_json.Destination).toBe(DESTINATION);
    expect(build.tx_json.Amount).toBe("1500000");
  });

  it("preserves vault id and converts the requested XRP amount", async () => {
    const client = createHarborRestClient({ mock: true });
    const build = expectOkData<TxBuild>(
      await client.op("tx.vaultDeposit", {
        account: requestedAccount,
        network: "devnet",
        vault_id: VAULT_ID,
        asset: XRP,
        amount: "3.25",
      }),
    );

    expect(build.tx_json.Account).toBe(requestedAccount);
    expect(build.tx_json.VaultID).toBe(VAULT_ID);
    expect(build.tx_json.Amount).toBe("3250000");
  });
});

describe.runIf(!useLiveHarbor)("mock delegation and policy execution", () => {
  it.each([
    ["249.99", "executed"],
    ["250", "needs_approval"],
    ["2000", "needs_approval"],
    ["2000.01", "blocked"],
  ] as const)("maps default-policy USD value %s to %s", async (amount, status) => {
    const client = createHarborRestClient({ mock: true });
    const owner = `${ACCOUNT}-${amount}`;
    await activateLink(client, owner);
    const build = await buildSwap(client, owner, amount);
    const result = await executeBuild(client, build, `boundary-${amount}`);

    expect(result.status).toBe(status);
  });

  it("blocks an unknown issuer and supports deterministic failure", async () => {
    const client = createHarborRestClient({ mock: true });
    await activateLink(client, ACCOUNT);
    const unknownIssuer = await buildSwap(client, ACCOUNT, "50", {
      currency: "RLUSD",
      issuer: "rUnknownIssuer111111111111111111111",
    });
    const blocked = await executeBuild(client, unknownIssuer, "unknown-issuer");
    const valid = await buildSwap(client, ACCOUNT, "50");
    const failed = await executeBuild(client, valid, "mock-failed:unit-test");

    expect(blocked.status).toBe("blocked");
    expect(failed.status).toBe("failed");
  });

  it("requires approval for a nondelegable transaction", async () => {
    const client = createHarborRestClient({ mock: true });
    await activateLink(client, ACCOUNT, ["OfferCreate"]);
    const build = expectOkData<TxBuild>(
      await client.op("tx.payment", {
        account: ACCOUNT,
        network: "testnet",
        to: DESTINATION,
        asset: RLUSD,
        amount: "50",
      }),
    );
    const result = await executeBuild(client, build, "nondelegable-payment");

    expect(build.delegable).toBe(false);
    expect(result.status).toBe("needs_approval");
  });

  it("makes the next otherwise-autonomous swap require approval after revoke", async () => {
    const client = createHarborRestClient({ mock: true });
    await activateLink(client, ACCOUNT);
    const before = await buildSwap(client, ACCOUNT, "10");
    expect((await executeBuild(client, before, "before-revoke")).status).toBe(
      "executed",
    );

    const revoked = expectOkData<{ status: string }>(
      await client.op("account.revoke", { owner: ACCOUNT, network: "testnet" }),
    );
    expect(revoked.status).toBe("revoked");

    const after = await buildSwap(client, ACCOUNT, "10");
    expect((await executeBuild(client, after, "after-revoke")).status).toBe(
      "needs_approval",
    );
  });

  it.each([
    ["99.99", "executed"],
    ["100", "needs_approval"],
    ["500", "needs_approval"],
    ["500.01", "blocked"],
  ] as const)("applies configured threshold %s as %s", async (amount, status) => {
    const client = createHarborRestClient({ mock: true });
    await activateLink(client, ACCOUNT);
    const policy: Policy = {
      ...DEFAULT_POLICY,
      execute_under_usd: 100,
      max_per_tx_usd: 500,
    };
    expectOkData(
      await client.op("policy.set", {
        owner: ACCOUNT,
        network: "testnet",
        policy,
      }),
    );
    const build = await buildSwap(client, ACCOUNT, amount);
    const result = await executeBuild(client, build, `custom-${amount}`);

    expect(result.status).toBe(status);
  });

  it("requires approval when policy omits an otherwise delegated type", async () => {
    const client = createHarborRestClient({ mock: true });
    await activateLink(client, ACCOUNT);
    const policy: Policy = {
      ...DEFAULT_POLICY,
      allowed_tx_types: ["TrustSet"],
    };
    expectOkData(
      await client.op("policy.set", {
        owner: ACCOUNT,
        network: "testnet",
        policy,
      }),
    );
    const build = await buildSwap(client, ACCOUNT, "10");
    const result = await executeBuild(client, build, "policy-permission");

    expect(result.status).toBe("needs_approval");
  });

  it("submits an approval and reports its transaction status", async () => {
    const client = createHarborRestClient({ mock: true });
    await activateLink(client, ACCOUNT);
    const build = await buildSwap(client, ACCOUNT, "250");
    const approval = await executeBuild(client, build, "approval-submit-status");
    expect(approval.status).toBe("needs_approval");
    if (approval.status !== "needs_approval") return;

    const submitted = expectOkData<z.infer<typeof TxSubmitSchema>>(
      await client.op("tx.submit", {
        approval_id: approval.approval_id,
        tx_blob: "1200002280000000",
      }),
    );
    TxSubmitSchema.parse(submitted);
    expect(submitted.status).toBe("validated");
    if (submitted.status !== "validated") return;

    const status = expectOkData<z.infer<typeof TxStatusSchema>>(
      await client.op("tx.status", { hash: submitted.hash }),
    );
    TxStatusSchema.parse(status);
    expect(status.status).toBe("validated");
    expect(status.hash).toBe(submitted.hash);
  });
});

describe.runIf(!useLiveHarbor)("REST authentication and errors", () => {
  it("fails fast when live REST authentication is missing", () => {
    expect(() =>
      createHarborRestClient({
        apiKey: "",
        baseUrl: "https://harbor.example",
        mock: false,
      }),
    ).toThrow(/requires an apiKey/i);
  });

  it("sends the configured bearer key and JSON request", async () => {
    const response = {
      ok: true as const,
      data: [],
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "test",
    };
    let request: { input?: RequestInfo | URL; init?: RequestInit } = {};
    const injectedFetch: typeof fetch = async (input, init) => {
      request = { input, init };
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };
    const client = createHarborRestClient({
      apiKey: "pilot:test-token",
      baseUrl: "https://harbor.example/",
      fetch: injectedFetch,
      mock: false,
    });

    await client.op("venues.list", {});

    expect(String(request.input)).toBe(
      "https://harbor.example/api/ops/venues.list",
    );
    expect(request.init?.method).toBe("POST");
    expect(new Headers(request.init?.headers).get("authorization")).toBe(
      "Bearer pilot:test-token",
    );
    expect(new Headers(request.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(request.init?.body).toBe("{}");
  });

  it("redacts the API key from an HTTP error body and message", async () => {
    const apiKey = "pilot:super-secret-token";
    const client = createHarborRestClient({
      apiKey,
      baseUrl: "https://harbor.example",
      fetch: async () =>
        new Response(`Authorization failed for ${apiKey}`, {
          status: 401,
          statusText: "Unauthorized",
        }),
      mock: false,
    });

    const error = await client.op("venues.list", {}).catch((reason: unknown) =>
      reason,
    );

    expect(error).toBeInstanceOf(HarborHttpError);
    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain(apiKey);
    expect((error as HarborHttpError).responseBody).not.toContain(apiKey);
  });
});

describe.runIf(!useLiveHarbor)("MCP AI SDK tools", () => {
  const mcp = createHarborMcpClient({ mock: true });

  afterAll(async () => {
    await mcp.close();
  });

  it("exposes executable search and execute tools", async () => {
    expect(mcp.tools.harbor_search).toBe(mcp.harbor_search);
    expect(mcp.tools.harbor_execute).toBe(mcp.harbor_execute);
    expect(mcp.tools.harbor_search.execute).toBeTypeOf("function");
    expect(mcp.tools.harbor_execute.execute).toBeTypeOf("function");

    const invokeSearch = mcp.tools.harbor_search.execute as unknown as (
      input: { query: string },
      options: { messages: never[]; toolCallId: string },
    ) => Promise<unknown>;
    const invokeExecute = mcp.tools.harbor_execute.execute as unknown as (
      input: { code: string },
      options: { messages: never[]; toolCallId: string },
    ) => Promise<unknown>;
    const options = { messages: [], toolCallId: "harbor-client-test" };

    const searchResult = await invokeSearch({ query: "venues" }, options);
    const executeResult = await invokeExecute(
      { code: "return await harbor.venues.list({})" },
      options,
    );

    expect(searchResult).toBeTruthy();
    EnvelopeSchema(z.array(VenueSchema)).parse(executeResult);
    expectNoSecretFields(searchResult);
    expectNoSecretFields(executeResult);
  });
});
