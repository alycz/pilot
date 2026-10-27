import { randomUUID } from "node:crypto";

import {
  CardTrustSchema,
  ExecResultSchema,
  PolicySchema,
  TxBuildSchema,
  type CardEvent,
  type CardTrust,
  type Envelope,
  type ExecResult,
  type Intent,
  type Network,
  type Policy,
  type TxBuild,
} from "@pilot/contracts";
import { IntentSchema, toBuild } from "@pilot/intents";
import { jsonSchema, tool, type Tool } from "ai";
import { z } from "zod";

import {
  CardStateMachine,
  safeErrorMessage,
  type CardEventSink,
} from "./card-state";
import {
  executeX402Compare,
  x402ModelReceipt,
  type X402DeliveredResult,
  type X402Harbor,
  type X402JournalReceipt,
  type X402PaymentEvent,
  type X402RuntimeMode,
} from "./x402";
import {
  guardrailNoticeFromEnvelope,
  type GuardrailNoticeSink,
} from "./guardrail-notice";
import {
  type ProposalProvider,
} from "./proposal-provider";
import { createAp4mModelTools, type Ap4mToolContext } from "./ap4m";
import { createStrategyProposalTool } from "./strategy-proposal";

type AccountContext = {
  main_account: string;
  budget_account: string;
  delegate_account?: string;
};

export interface AgentMemory {
  search(query: string, limit: number): Promise<unknown> | unknown;
  read(path: string): Promise<unknown> | unknown;
}

export interface AgentHarborRest {
  op(name: any, args: any): Promise<Envelope<unknown>>;
}

export interface AgentHarborMcp {
  tools: Record<string, Tool<any, any>>;
  close(): Promise<void>;
}

export interface AgentToolOptions {
  account: AccountContext;
  network: Network;
  harborRest: AgentHarborRest;
  harborMcp: AgentHarborMcp;
  memory?: AgentMemory;
  emitCard?: CardEventSink;
  emitGuardrailNotice?: GuardrailNoticeSink;
  emitPreference?: (event: PreferenceProposalEvent) => void | Promise<void>;
  loadPolicy?: () => Promise<Policy | undefined> | Policy | undefined;
  onValidated?: (execution: ValidatedExecution) => Promise<void> | void;
  x402?: {
    operationId: string;
    mode: X402RuntimeMode;
    emit?: (event: X402PaymentEvent) => Promise<void> | void;
    onDelivered?: (result: X402DeliveredResult) => Promise<X402JournalReceipt> | X402JournalReceipt;
  };
  now?: () => Date;
  ap4m?: Ap4mToolContext;
  /** Trusted server-side input for a paper-only strategy preview. */
  strategyPaperObservation?: () =>
    | Promise<Record<string, unknown>>
    | Record<string, unknown>;
  /** Optional advisory provider. It receives no Harbor, wallet, or signing capability. */
  agentCore?: ProposalProvider;
}

export type PreferenceProposalEvent = {
  id: string;
  state: "proposed";
  preference: string;
  reason?: string;
  at: string;
};

export type ValidatedExecution = {
  intent: Intent;
  build: TxBuild;
  exec: Extract<ExecResult, { status: "executed" }>;
};

export interface IntentExecutionResult {
  intent: Intent;
  build?: TxBuild;
  exec?: ExecResult;
  state: CardEvent["state"];
  error?: string;
}

const MemorySearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

const MemoryReadSchema = z
  .object({ path: z.string().trim().min(1).max(500) })
  .strict();

const EmptySchema = z.object({}).strict();

const PreferenceProposalSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    preference: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const AgentCoreResearchSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000),
  })
  .strict();

const AGENTCORE_PUBLIC_MARKET_CONTEXT = Object.freeze({
  pair: "XRP/RLUSD",
  venue: "xrpl-testnet-dex",
  timeframe: "spot",
} as const);

const HarborExecuteSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(24 * 1024)
      .describe(
        "One read-only Harbor call using a JSON object argument, for example: return await harbor.venues.list({});",
      ),
  })
  .strict();

const HARBOR_CALL_PATTERN =
  /^\s*return\s+await\s+harbor\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/;

const READ_ONLY_HARBOR_OPERATIONS = new Set([
  "venues.list",
  "venues.get",
  "venues.compare",
  "ledger.account.info",
  "ledger.account.lines",
  "ledger.account.objects",
  "ledger.account.tx",
  "dex.book",
  "dex.depth",
  "analytics.marketSnapshot",
  "amm.info",
  "tokens.lookup",
  "yield.options",
  "account.status",
  "policy.get",
  "tx.status",
  "near.intents.tokens",
  "near.intents.quote",
  "near.intents.status",
]);

const ACCOUNT_ARGUMENT_BY_OPERATION: Record<string, "account" | "owner"> = {
  "ledger.account.info": "account",
  "ledger.account.lines": "account",
  "ledger.account.objects": "account",
  "ledger.account.tx": "account",
  "account.status": "owner",
  "policy.get": "owner",
};

const IntentToolSchema = jsonSchema<Intent>(
  {
    type: "object",
    description:
      "One strict Pilot intent. Fields beyond id, network, and kind depend on the selected Intent kind.",
    properties: {
      id: { type: "string" },
      network: {
        enum: ["mainnet", "testnet", "devnet", "lending-devnet"],
      },
      kind: {
        enum: [
          "swap",
          "limit",
          "cancel",
          "lp_deposit",
          "lp_withdraw",
          "vault_deposit",
          "pay",
          "fund_budget",
        ],
      },
      sell: { type: "object" },
      buy: { type: "object" },
      asset: { type: "object" },
      asset2: { type: "object" },
      amount: { type: "string" },
      side: { enum: ["sell", "buy"] },
      max_slippage_bps: { type: "number" },
      sell_amount: { type: "string" },
      buy_amount: { type: "string" },
      expires_at: { type: "string" },
      offer_sequence: { type: "number" },
      amount2: { type: "string" },
      vault_id: { type: "string" },
      to: { type: "string" },
      memo: { type: "string" },
      url: { type: "string" },
      max_price_drops: { type: "string" },
    },
    required: ["id", "network", "kind"],
    additionalProperties: false,
  },
  {
    validate: (value) => {
      const parsed = IntentSchema.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: new Error(parsed.error.message) };
    },
  },
);

function harborError(envelope: Extract<Envelope<unknown>, { ok: false }>): Error {
  const code = envelope.error.code ? ` (${envelope.error.code})` : "";
  return new Error(`${envelope.error.service}${code}: ${envelope.error.message}`);
}

function mergeCardTrust(
  ...parts: Array<CardTrust | undefined>
): CardTrust | undefined {
  const merged = Object.assign({}, ...parts.filter(Boolean));
  return Object.keys(merged).length === 0
    ? undefined
    : CardTrustSchema.parse(merged);
}

/** Project only contract-bounded Harbor provenance; never infer provider use. */
export function cardTrustFromHarborEnvelope(
  envelope: Envelope<unknown>,
): CardTrust | undefined {
  if (!envelope.ok || !envelope.trust) return undefined;
  return mergeCardTrust(
    envelope.trust.screen ? { screen: envelope.trust.screen } : undefined,
    envelope.trust.rpc ? { rpc: envelope.trust.rpc.route } : undefined,
  );
}

function cardTrustFromExecutedResult(
  exec: Extract<ExecResult, { status: "executed" }>,
): CardTrust | undefined {
  return mergeCardTrust(
    exec.signer ? { signer: exec.signer } : undefined,
    exec.confirmation ? { confirmation: exec.confirmation } : undefined,
  );
}

async function callBuilder(
  harbor: AgentHarborRest,
  request: ReturnType<typeof toBuild>,
  emitGuardrailNotice?: GuardrailNoticeSink,
): Promise<Envelope<TxBuild>> {
  const response = await harbor.op(
    request.op,
    request.args as unknown as Record<string, unknown>,
  );
  await emitSafeGuardrailNotice(response, emitGuardrailNotice);
  if (!response.ok) return response;
  return { ...response, data: TxBuildSchema.parse(response.data) };
}

async function callExecute(
  harbor: AgentHarborRest,
  build: TxBuild,
  intent: Intent,
  emitGuardrailNotice?: GuardrailNoticeSink,
): Promise<Envelope<ExecResult>> {
  const response = await harbor.op("tx.execute", {
    build_id: build.build_id,
    idempotency_key: intent.id,
  });
  await emitSafeGuardrailNotice(response, emitGuardrailNotice);
  if (!response.ok) return response;
  return { ...response, data: ExecResultSchema.parse(response.data) };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const rightEntries = Object.entries(right as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) =>
      key === rightEntries[index]?.[0] && jsonEqual(value, rightEntries[index]?.[1]));
  }
  return left === right;
}

function requestAmount(asset: unknown, value: unknown): unknown {
  if (!asset || typeof asset !== "object" || typeof value !== "string") return undefined;
  const wireAsset = asset as { currency?: unknown; issuer?: unknown };
  if (wireAsset.currency === "XRP") {
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
    return match ? `${match[1]}${(match[2] ?? "").padEnd(6, "0")}`.replace(/^0+(?=\d)/, "") : undefined;
  }
  return { currency: wireAsset.currency, issuer: wireAsset.issuer, value };
}

function rippleTime(iso: string): number | undefined {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) return undefined;
  const seconds = Math.floor(milliseconds / 1_000) - 946_684_800;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function amountMatchesAsset(amount: unknown, asset: unknown): boolean {
  if (!asset || typeof asset !== "object") return false;
  const expected = asset as { currency?: unknown; issuer?: unknown };
  if (expected.currency === "XRP") return typeof amount === "string" && /^\d+$/.test(amount);
  return Boolean(amount && typeof amount === "object" && !Array.isArray(amount) &&
    (amount as Record<string, unknown>).currency === expected.currency &&
    (amount as Record<string, unknown>).issuer === expected.issuer);
}

const TX_BASE_FIELDS = [
  "TransactionType", "Account", "Fee", "Sequence", "LastLedgerSequence",
  "SourceTag", "Memos", "SigningPubKey",
] as const;

function hasOnlyFields(transaction: Record<string, unknown>, fields: string[]): boolean {
  const allowed = new Set([...TX_BASE_FIELDS, ...fields]);
  return Object.keys(transaction).every((field) => allowed.has(field));
}

function assertIntentTransaction(
  build: TxBuild,
  request: ReturnType<typeof toBuild>,
): void {
  const tx = build.tx_json;
  const args = request.args as Record<string, any>;
  let safe = false;
  switch (request.op) {
    case "tx.swap": {
      const fixed = args.side === "sell" ? tx.TakerGets : tx.TakerPays;
      const floating = args.side === "sell" ? tx.TakerPays : tx.TakerGets;
      const floatingAsset = args.side === "sell" ? args.buy : args.sell;
      const executionFlag = args.execution_mode === "fill_or_kill" ? 0x0004_0000 : 0x0002_0000;
      safe = tx.TransactionType === "OfferCreate" && jsonEqual(fixed, args.amount) &&
        amountMatchesAsset(floating, floatingAsset) && hasOnlyFields(tx, ["TakerGets", "TakerPays", "Flags"]) &&
        tx.Flags === (executionFlag | (args.side === "sell" ? 0x0008_0000 : 0));
      break;
    }
    case "tx.offer":
      safe = tx.TransactionType === "OfferCreate" &&
        jsonEqual(tx.TakerGets, requestAmount(args.sell, args.sell_amount)) &&
        jsonEqual(tx.TakerPays, requestAmount(args.buy, args.buy_amount)) &&
        hasOnlyFields(tx, ["TakerGets", "TakerPays", "Expiration", "Flags"]) &&
        (tx.Flags === undefined || tx.Flags === 0) &&
        (args.expires_at === undefined ? tx.Expiration === undefined : tx.Expiration === rippleTime(args.expires_at));
      break;
    case "tx.offerCancel":
      safe = tx.TransactionType === "OfferCancel" && tx.OfferSequence === args.offer_sequence &&
        hasOnlyFields(tx, ["OfferSequence", "Flags"]) && (tx.Flags === undefined || tx.Flags === 0);
      break;
    case "tx.ammDeposit":
      safe = tx.TransactionType === "AMMDeposit" && jsonEqual(tx.Asset, args.asset) &&
        jsonEqual(tx.Asset2, args.asset2) && jsonEqual(tx.Amount, args.amount) &&
        (args.amount2 === undefined || jsonEqual(tx.Amount2, args.amount2)) && tx.Flags === args.flags &&
        hasOnlyFields(tx, ["Asset", "Asset2", "Amount", "Amount2", "EPrice", "LPTokenOut", "TradingFee", "Flags"]);
      break;
    case "tx.ammWithdraw":
      safe = tx.TransactionType === "AMMWithdraw" && jsonEqual(tx.Asset, args.asset) &&
        jsonEqual(tx.Asset2, args.asset2) && tx.Flags === args.flags &&
        (jsonEqual(tx.Amount, args.amount) || jsonEqual(tx.LPTokenIn, args.amount)) &&
        (args.amount2 === undefined || jsonEqual(tx.Amount2, args.amount2)) &&
        hasOnlyFields(tx, ["Asset", "Asset2", "Amount", "Amount2", "EPrice", "LPTokenIn", "Flags"]);
      break;
    case "tx.vaultDeposit":
      safe = tx.TransactionType === "VaultDeposit" && tx.VaultID === args.vault_id &&
        jsonEqual(tx.Amount, args.amount) && hasOnlyFields(tx, ["VaultID", "Amount", "Flags"]) &&
        (tx.Flags === undefined || tx.Flags === 0);
      break;
    case "tx.payment":
      safe = tx.TransactionType === "Payment" && tx.Destination === args.to &&
        jsonEqual(tx.Amount, requestAmount(args.asset, args.amount)) &&
        hasOnlyFields(tx, ["Destination", "Amount", "Flags"]) &&
        (tx.Flags === undefined || tx.Flags === 0) && args.memo === undefined;
      break;
  }
  if (!safe) throw new Error("Harbor returned a transaction that does not match the validated intent.");
}

function assertExecutableBuild(
  build: TxBuild,
  intent: Intent,
  request: ReturnType<typeof toBuild>,
): void {
  const account = "account" in request.args ? request.args.account : undefined;
  const fee = typeof build.tx_json.Fee === "string" && /^\d+$/.test(build.tx_json.Fee)
    ? Number(build.tx_json.Fee)
    : Number.NaN;
  if (
    build.network !== intent.network ||
    build.summary.account !== account ||
    build.tx_json.Account !== account ||
    !Number.isSafeInteger(fee) || fee < 0 || fee > 100 ||
    !Number.isSafeInteger(build.tx_json.Sequence) || Number(build.tx_json.Sequence) < 0 ||
    !Number.isSafeInteger(build.tx_json.LastLedgerSequence) || Number(build.tx_json.LastLedgerSequence) < 1 ||
    "TxnSignature" in build.tx_json ||
    (build.tx_json.SigningPubKey !== undefined && build.tx_json.SigningPubKey !== "") ||
    build.simulate.applied !== false ||
    build.simulate.engine_result !== "tesSUCCESS" ||
    build.preflight.length === 0 ||
    build.preflight.some((check) => check.pass !== true)
  ) {
    throw new Error("Harbor returned a build that did not pass exact simulation and preflight checks.");
  }
  assertIntentTransaction(build, request);
}

function assertSafeExecutionResult(exec: ExecResult, build: TxBuild, now: Date): void {
  if (exec.status === "executed") {
    if (!/^[A-Fa-f0-9]{64}$/.test(exec.hash) || !Number.isSafeInteger(exec.ledger_index) || exec.ledger_index < 1) {
      throw new Error("Harbor returned an invalid validated execution reference.");
    }
    return;
  }
  if (exec.status === "needs_approval") {
    const semantic = (transaction: Record<string, unknown>) => {
      const copy = { ...transaction };
      delete copy.Fee;
      delete copy.Sequence;
      delete copy.LastLedgerSequence;
      return copy;
    };
    if (
      !exec.approval_id.trim() || exec.approval_id.length > 256 ||
      !Number.isFinite(Date.parse(exec.expires_at)) || Date.parse(exec.expires_at) <= now.getTime() ||
      exec.tx_json.Account !== build.tx_json.Account ||
      exec.tx_json.TransactionType !== build.tx_json.TransactionType ||
      !jsonEqual(semantic(exec.tx_json), semantic(build.tx_json))
    ) {
      throw new Error("Harbor returned an invalid owner-approval result.");
    }
  }
}

/**
 * Deterministic server-side intent path. The model supplies only a typed intent;
 * it never chooses whether policy executes, approves, or blocks the build.
 */
export async function executeProposedIntent(
  input: unknown,
  options: Pick<
    AgentToolOptions,
    | "account"
    | "emitCard"
    | "emitGuardrailNotice"
    | "harborRest"
    | "network"
    | "now"
    | "loadPolicy"
    | "onValidated"
  >,
): Promise<IntentExecutionResult> {
  const intent = IntentSchema.parse(input);
  if (intent.kind === "x402_call") {
    return {
      intent,
      state: "failed",
      error: "x402_call must use the dedicated local Testnet x402_compare operation.",
    };
  }
  if (intent.kind === "ap4m_purchase") {
    return {
      intent,
      state: "failed",
      error: "ap4m_purchase must use the dedicated bounded AP4M purchase tool.",
    };
  }
  const card = new CardStateMachine(intent, {
    emit: options.emitCard,
    now: options.now,
  });
  let build: TxBuild | undefined;
  let exec: ExecResult | undefined;
  let harborTrust: CardTrust | undefined;

  await card.drafting();
  try {
    if (options.network === "mainnet" || intent.network === "mainnet") {
      throw new Error("Mainnet transaction execution is disabled in this demo.");
    }
    if (intent.network !== options.network) {
      throw new Error(
        `Intent network ${intent.network} does not match the server-authorized ${options.network} network.`,
      );
    }

    const request = toBuild(intent, options.account);
    await card.planned();

    const buildEnvelope = await callBuilder(
      options.harborRest,
      request,
      options.emitGuardrailNotice,
    );
    if (!buildEnvelope.ok) throw harborError(buildEnvelope);
    build = buildEnvelope.data;
    assertExecutableBuild(build, intent, request);
    harborTrust = cardTrustFromHarborEnvelope(buildEnvelope);
    await card.simulated(build, harborTrust);

    const policy = await options.loadPolicy?.();
    if (policy) {
      const policyEnvelope = await options.harborRest.op("policy.set", {
        owner: options.account.budget_account,
        network: options.network,
        policy: PolicySchema.parse(policy),
      });
      await emitSafeGuardrailNotice(
        policyEnvelope,
        options.emitGuardrailNotice,
      );
      if (!policyEnvelope.ok) throw harborError(policyEnvelope);
    }

    const execEnvelope = await callExecute(
      options.harborRest,
      build,
      intent,
      options.emitGuardrailNotice,
    );
    if (!execEnvelope.ok) throw harborError(execEnvelope);
    exec = execEnvelope.data;
    assertSafeExecutionResult(exec, build, options.now?.() ?? new Date());
    harborTrust = mergeCardTrust(
      harborTrust,
      cardTrustFromHarborEnvelope(execEnvelope),
    );
    await card.policyChecked({
      build,
      ...(harborTrust ? { trust: harborTrust } : {}),
      ...(exec.status === "needs_approval" || exec.status === "blocked"
        ? { policy: exec.policy }
        : {}),
    });

    switch (exec.status) {
      case "executed": {
        // Harbor's atomic tx.execute response represents policy, signing,
        // submission, and validation. Normalize it into ordered UI states, but
        // attach the final ExecResult only to the validated event so earlier
        // cards never claim validation before that state.
        await card.executing(build, harborTrust);
        await card.submitted(build, exec.hash, harborTrust);
        await card.validated(
          build,
          exec,
          exec.hash,
          mergeCardTrust(harborTrust, cardTrustFromExecutedResult(exec)),
        );
        try {
          await options.onValidated?.({ intent, build, exec });
        } catch (error) {
          return {
            intent,
            build,
            exec,
            state: "validated",
            error: `Transaction validated, but the vault write failed: ${safeErrorMessage(error)}`,
          };
        }
        return { intent, build, exec, state: "validated" };
      }
      case "needs_approval":
        await card.awaitingApproval(build, exec, harborTrust);
        return { intent, build, exec, state: "awaiting_approval" };
      case "blocked":
        await card.blocked(build, exec, harborTrust);
        return { intent, build, exec, state: "blocked" };
      case "failed":
        await card.executing(build, harborTrust);
        await card.failed(exec.detail, { build, exec, ...(harborTrust ? { trust: harborTrust } : {}) });
        return {
          intent,
          build,
          exec,
          state: "failed",
          error: exec.detail,
        };
    }
  } catch (error) {
    if (!card.terminal) await card.failed(error, { build, exec, ...(harborTrust ? { trust: harborTrust } : {}) });
    return {
      intent,
      ...(build ? { build } : {}),
      ...(exec ? { exec } : {}),
      state: "failed",
      error: safeErrorMessage(error),
    };
  }
}

function readOnlyHarborExecute(options: AgentToolOptions): Tool<any, any> | undefined {
  const source = options.harborMcp.tools.harbor_execute;
  if (!source?.execute) return undefined;

  const invoke = source.execute as unknown as (
    input: { code: string },
    callOptions?: unknown,
  ) => Promise<unknown>;

  return tool({
    description:
      "Execute exactly one read-only Harbor operation. Transaction builders, execution, submission, account linking, and policy writes are unavailable; use propose_intent for authorized transaction flows.",
    inputSchema: HarborExecuteSchema,
    execute: async ({ code }, callOptions) => {
      const match = HARBOR_CALL_PATTERN.exec(code);
      if (!match) {
        throw new Error(
          "harbor_execute accepts exactly one canonical read-only Harbor call with a JSON object argument.",
        );
      }

      const operation = match[1];
      if (!READ_ONLY_HARBOR_OPERATIONS.has(operation)) {
        throw new Error(
          `Harbor operation ${operation} is not read-only. Use propose_intent for transaction flows.`,
        );
      }

      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(match[2]) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("expected an object");
        }
        args = parsed as Record<string, unknown>;
      } catch {
        throw new Error(
          "harbor_execute arguments must be one JSON object containing only data.",
        );
      }

      if ("network" in args && args.network !== options.network) {
        throw new Error("Harbor reads must use the server-authorized network.");
      }
      const accountArgument = ACCOUNT_ARGUMENT_BY_OPERATION[operation];
      if (
        accountArgument &&
        args[accountArgument] !== options.account.budget_account
      ) {
        throw new Error(
          "Account-scoped Harbor reads must use the connected budget account.",
        );
      }

      const canonical = `return await harbor.${operation}(${JSON.stringify(args)});`;
      const result = await invoke({ code: canonical }, callOptions);
      await emitSafeGuardrailNotice(result, options.emitGuardrailNotice);
      return result;
    },
  });
}

async function portfolio(options: AgentToolOptions): Promise<unknown> {
  const account = options.account.budget_account;
  const args = { account, network: options.network };
  const [info, lines, objects, delegation] = await Promise.all([
    options.harborRest.op("ledger.account.info", args),
    options.harborRest.op("ledger.account.lines", args),
    options.harborRest.op("ledger.account.objects", args),
    options.harborRest.op("account.status", {
      owner: account,
      network: options.network,
    }),
  ]);
  await Promise.all(
    [info, lines, objects, delegation].map((result) =>
      emitSafeGuardrailNotice(result, options.emitGuardrailNotice),
    ),
  );
  return { account, network: options.network, info, lines, objects, delegation };
}

async function emitSafeGuardrailNotice(
  envelope: unknown,
  sink?: GuardrailNoticeSink,
): Promise<void> {
  if (!sink) return;
  const notice = guardrailNoticeFromEnvelope(envelope);
  if (notice) await sink(notice);
}

/** Tool set exposed to streamText. No signing capability is included. */
export function createAgentTools(options: AgentToolOptions) {
  const blockedIntents = new Set<string>();
  let mutationInvocationClaimed = false;
  const claimMutation = (): boolean => {
    if (mutationInvocationClaimed) return false;
    mutationInvocationClaimed = true;
    return true;
  };
  let agentCoreInvocationClaimed = false;
  let guardrailNoticeEmitted = false;
  const turnOptions: AgentToolOptions = {
    ...options,
    emitGuardrailNotice: async (notice) => {
      if (guardrailNoticeEmitted || !options.emitGuardrailNotice) return;
      guardrailNoticeEmitted = true;
      await options.emitGuardrailNotice(notice);
    },
  };
  const harborTools: Record<string, Tool<any, any>> = {};
  const harborSearch = options.harborMcp.tools.harbor_search;
  if (harborSearch) harborTools.harbor_search = harborSearch;
  const harborExecute = readOnlyHarborExecute(turnOptions);
  if (harborExecute) harborTools.harbor_execute = harborExecute;
  let x402Execution: Promise<X402PaymentEvent> | undefined;
  const x402Tools = options.x402 && options.network === "testnet"
    ? {
      x402_compare: tool({
        description:
          "Purchase exactly one approved local Testnet premium venue comparison. The server fixes the owner, network, resource, merchant receiver, exact 5000-drop price, and stable operation identity; this tool accepts no transaction or HTTP parameters.",
        inputSchema: EmptySchema,
        execute: async () => {
          x402Execution ??= executeX402Compare({
            owner: options.account.budget_account,
            network: "testnet",
            operationId: options.x402!.operationId,
            mode: options.x402!.mode,
            harbor: options.harborRest as X402Harbor,
            emit: options.x402!.emit,
            onDelivered: options.x402!.onDelivered,
            now: options.now,
          });
          return x402ModelReceipt(await x402Execution);
        },
      }),
    }
    : {};

  // x402 is a dedicated model run. No generic mutation or preference tool is
  // present after merchant data has been fetched, even though the model sees
  // only the fixed receipt projection below.
  if (options.x402) return x402Tools;

  const ap4mTools = createAp4mModelTools({
    ...options,
    ...(options.ap4m
      ? { ap4m: { ...options.ap4m, claimMutation } }
      : {}),
  });
  const agentCoreTools = options.agentCore?.enabled
    ? {
      agentcore_research: tool({
        description:
          "Ask the configured AgentCore runtime for bounded read-only XRP/RLUSD XRPL Testnet spot research. The server fixes all market selectors. It cannot build, approve, sign, submit, or pay for transactions; any later action still requires propose_intent and Harbor policy.",
        inputSchema: AgentCoreResearchSchema,
        execute: async ({ query }, callOptions) => {
          if (mutationInvocationClaimed || agentCoreInvocationClaimed) {
            throw new Error("AgentCore research is limited to one isolated read-only call per chat run");
          }
          agentCoreInvocationClaimed = true;
          return options.agentCore!.propose({
            requestId: `agentcore-${randomUUID()}`,
            purpose: "read",
            prompt: query,
            context: AGENTCORE_PUBLIC_MARKET_CONTEXT,
          }, { signal: callOptions?.abortSignal });
        },
      }),
    }
    : {};

  // AgentCore output is untrusted external evidence. Its dedicated model run
  // never co-exposes transaction, payment, preference, or memory tools, so a
  // prompt injection cannot spend the already-verified wallet proof.
  if (options.agentCore?.enabled) return agentCoreTools;

  return {
    ...harborTools,
    ...x402Tools,
    ...ap4mTools,
    propose_strategy: createStrategyProposalTool({
      account: options.account.budget_account,
      harbor: options.harborRest,
      ...(options.strategyPaperObservation
        ? { paperObservation: options.strategyPaperObservation }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
    propose_intent: tool({
      description:
        "Propose one explicit user-authorized typed intent. Server code validates, builds, simulates, checks policy, and executes or requests approval.",
      // The model gets portable JSON Schema; @pilot/intents performs strict
      // validation both here and again before deterministic execution.
      inputSchema: IntentToolSchema,
      execute: async (intent) => {
        const { id: _id, ...intentWithoutId } = intent;
        const fingerprint = JSON.stringify(intentWithoutId);
        if (blockedIntents.has(fingerprint)) {
          return {
            intent,
            state: "blocked" as const,
            error:
              "This intent was already blocked in this run and was not retried.",
          };
        }
        if (!claimMutation()) {
          return {
            intent,
            state: "blocked" as const,
            error:
              "This authenticated run already invoked propose_intent; the same wallet proof cannot authorize another mutating execution.",
          };
        }
        const result = await executeProposedIntent(intent, turnOptions);
        if (result.state === "blocked") blockedIntents.add(fingerprint);
        return result;
      },
    }),
    memory_search: tool({
      description:
        "Search the user's Pilot memory for relevant notes. This is context, not a live market-data source.",
      inputSchema: MemorySearchSchema,
      execute: async ({ query, limit }) =>
        options.memory
          ? options.memory.search(query, limit)
          : { results: [], caveat: "Memory is not configured." },
    }),
    propose_preference: tool({
      description:
        "Propose a user preference as a pending card. This never writes Profile.md; only the explicit acceptance endpoint can persist it.",
      inputSchema: PreferenceProposalSchema,
      execute: async (proposal) => {
        const event: PreferenceProposalEvent = {
          ...proposal,
          state: "proposed",
          at: (options.now ?? (() => new Date()))().toISOString(),
        };
        await options.emitPreference?.(event);
        return event;
      },
    }),
    memory_read: tool({
      description: "Read one specific Pilot memory note returned by memory_search.",
      inputSchema: MemoryReadSchema,
      execute: async ({ path }) =>
        options.memory
          ? options.memory.read(path)
          : { path, content: null, caveat: "Memory is not configured." },
    }),
    portfolio_get: tool({
      description:
        "Read the connected budget account's current balances, objects, and delegation status.",
      inputSchema: EmptySchema,
      execute: () => portfolio(turnOptions),
    }),
  };
}
