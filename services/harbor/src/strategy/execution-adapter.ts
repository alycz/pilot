import type { XrplRpc } from "../adapters/xrpl-rpc";
import { OpRegistry } from "../catalog/registry";
import type { Strategy, StrategyDecision } from "../contracts";
import { createHarborProvider } from "../executor/providers";
import generatedOps from "../ops/index.gen";
import type {
  StrategyBuild,
  StrategyExecuteResult,
  StrategyExecutionAdapter,
  StrategyReconcileResult,
} from "./runner";
import type { StrategyObservation } from "./engine";
import type { UnresolvedStrategyExecution } from "./store";

type ProductionAdapterInput = {
  principal: string;
  db: D1Database;
  env: Record<string, unknown>;
  xrplRpc: XrplRpc;
};

const SCALE = 1_000_000_000_000_000n;

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, message: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,15})?$/.test(value)) throw new Error(message);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(15, "0"));
}

function format(value: bigint): string {
  if (value < 0n) throw new Error("negative values are not supported");
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(15, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function divide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("invalid quote denominator");
  return numerator * SCALE / denominator;
}

function issuedValue(raw: unknown, currency: string, issuer: string): bigint {
  const amount = record(raw, "issued amount is malformed");
  if (amount.currency !== currency || amount.issuer !== issuer) throw new Error("book asset does not match mandate");
  return decimal(amount.value, "issued amount value is malformed");
}

function xrpValue(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error("XRP amount is malformed");
  return BigInt(raw) * SCALE / 1_000_000n;
}

function funded(offer: Record<string, unknown>, side: "gets" | "pays"): unknown {
  return offer[`taker_${side}_funded`] ?? offer[side === "gets" ? "TakerGets" : "TakerPays"];
}

function bookPriceAndLiquidity(result: Record<string, unknown>, strategy: Strategy,
  orientation: "xrp_gets" | "issued_gets"): { price: bigint; liquidity: bigint; ledger: number } {
  if (!Array.isArray(result.offers) || result.offers.length === 0) throw new Error("executable book is empty");
  const offer = record(result.offers[0], "book offer is malformed");
  const gets = orientation === "xrp_gets"
    ? xrpValue(funded(offer, "gets"))
    : issuedValue(funded(offer, "gets"), strategy.mandate.issued_asset.currency, strategy.mandate.issued_asset.issuer);
  const pays = orientation === "xrp_gets"
    ? issuedValue(funded(offer, "pays"), strategy.mandate.issued_asset.currency, strategy.mandate.issued_asset.issuer)
    : xrpValue(funded(offer, "pays"));
  const direct = divide(pays, gets);
  const price = orientation === "xrp_gets" ? direct : divide(SCALE, direct);
  const liquidity = orientation === "xrp_gets" ? pays : gets;
  if (!Number.isSafeInteger(result.ledger_index) || Number(result.ledger_index) <= 0) throw new Error("book ledger is missing");
  return { price, liquidity, ledger: Number(result.ledger_index) };
}

function unwrap(value: unknown): unknown {
  const envelope = record(value, "Harbor operation returned an invalid envelope");
  if (envelope.ok !== true) {
    const error = record(envelope.error, "Harbor operation failed");
    const failure = new Error(typeof error.message === "string" ? error.message : "Harbor operation failed") as Error & { code?: string };
    if (typeof error.code === "string") failure.code = error.code;
    throw failure;
  }
  return envelope.data;
}

function amountDrops(value: string, price: string): string {
  const quoteValue = decimal(value, "proposed value is malformed");
  const quotePrice = decimal(price, "quote is malformed");
  const drops = quoteValue * 1_000_000n / quotePrice;
  if (drops <= 0n) throw new Error("proposed order rounds below one drop");
  return drops.toString();
}

export function createProductionStrategyAdapter(input: ProductionAdapterInput): StrategyExecutionAdapter {
  const registry = new OpRegistry(generatedOps);
  const provider = createHarborProvider(registry, {
    principal: input.principal,
    db: input.db,
    env: input.env,
    xrplRpc: input.xrplRpc,
  });
  const observations = new Map<string, StrategyObservation>();

  return {
    async observe(strategy, readStartedAt) {
      const asset = strategy.mandate.issued_asset;
      const accountInfo = await input.xrplRpc.request("testnet", "account_info", {
        account: strategy.mandate.account, ledger_index: "validated", queue: false,
      });
      const accountData = record(accountInfo.account_data, "account_info is malformed");
      if (accountInfo.validated !== true || accountData.Account !== strategy.mandate.account ||
          typeof accountData.Balance !== "string" || !Number.isSafeInteger(accountData.OwnerCount) ||
          Number(accountData.OwnerCount) < 0 || !Number.isSafeInteger(accountInfo.ledger_index)) {
        throw new Error("validated account_info does not match mandate");
      }
      const ledger = Number(accountInfo.ledger_index);
      const [lines, xrpGets, issuedGets, fee, server, link, policy] = await Promise.all([
        input.xrplRpc.request("testnet", "account_lines", {
          account: strategy.mandate.account, peer: asset.issuer, ledger_index: ledger, limit: 400,
        }),
        input.xrplRpc.request("testnet", "book_offers", {
          taker_gets: { currency: "XRP" }, taker_pays: asset, ledger_index: ledger, limit: 1,
        }),
        input.xrplRpc.request("testnet", "book_offers", {
          taker_gets: asset, taker_pays: { currency: "XRP" }, ledger_index: ledger, limit: 1,
        }),
        input.xrplRpc.request("testnet", "fee"),
        input.xrplRpc.request("testnet", "server_info"),
        input.db.prepare(`SELECT status, permissions, frozen_at FROM links WHERE principal = ? AND owner = ? AND network = 'testnet'`)
          .bind(input.principal, strategy.mandate.account).first<{ status: string; permissions: string; frozen_at: string | null }>(),
        input.db.prepare(`SELECT json FROM policies WHERE principal = ? AND owner = ? AND network = 'testnet'`)
          .bind(input.principal, strategy.mandate.account).first<{ json: string }>(),
      ]);
      if (lines.validated !== true || Number(lines.ledger_index) !== ledger || !Array.isArray(lines.lines)) {
        throw new Error("account_lines is not validated at the observation ledger");
      }
      const line = lines.lines.map((value) => record(value, "trust line is malformed"))
        .find((value) => value.account === asset.issuer && value.currency === asset.currency);
      if (!line || typeof line.balance !== "string") throw new Error("exact issued trust line is missing");
      if (line.freeze === true || line.freeze_peer === true || line.deep_freeze === true || line.deep_freeze_peer === true ||
          ("authorized" in line && line.authorized !== true) ||
          ("peer_authorized" in line && line.peer_authorized !== true)) {
        throw new Error("exact issued trust line is frozen or unauthorized");
      }
      if (xrpGets.validated !== true || issuedGets.validated !== true) {
        throw new Error("order books are not validated");
      }
      const forward = bookPriceAndLiquidity(xrpGets, strategy, "xrp_gets");
      const reverse = bookPriceAndLiquidity(issuedGets, strategy, "issued_gets");
      if (forward.ledger !== ledger || reverse.ledger !== ledger) throw new Error("quote ledger is contradictory");
      const bid = forward.price < reverse.price ? forward.price : reverse.price;
      const ask = forward.price > reverse.price ? forward.price : reverse.price;
      const feeDrops = record(fee.drops, "fee response is malformed").open_ledger_fee;
      if (typeof feeDrops !== "string") throw new Error("fee response is malformed");
      const serverInfo = record(server.info, "server_info is malformed");
      const validated = record(serverInfo.validated_ledger, "validated ledger reserve is missing");
      const reserveBase = decimal(String(validated.reserve_base_xrp), "reserve base is malformed") * 1_000_000n / SCALE;
      const reserveIncrement = decimal(String(validated.reserve_inc_xrp), "reserve increment is malformed") * 1_000_000n / SCALE;
      let permissions: unknown = [];
      try { permissions = JSON.parse(link?.permissions ?? "[]"); } catch { permissions = []; }
      const observation: StrategyObservation = {
        account: strategy.mandate.account,
        network: "testnet",
        issuedCurrency: asset.currency,
        issuedIssuer: asset.issuer,
        xrpBalanceDrops: accountData.Balance,
        issuedBalance: line.balance,
        bid: format(bid),
        ask: format(ask),
        executableLiquidityValue: format(forward.liquidity < reverse.liquidity ? forward.liquidity : reverse.liquidity),
        feeDrops,
        reserveBaseDrops: reserveBase.toString(),
        reserveIncrementDrops: reserveIncrement.toString(),
        ownerCount: Number(accountData.OwnerCount),
        pendingDailyValue: "0",
        ledgerIndex: ledger,
        quoteLedgerIndex: ledger,
        // The runner supplies a clock sample taken immediately before this
        // observation attempt and samples again after it returns. Therefore
        // all account/book/DB latency consumes the quote-age allowance.
        observedAt: readStartedAt.toISOString(),
        ...(strategy.last_trade_at ? { lastTradeAt: strategy.last_trade_at } : {}),
        grantActive: link?.status === "active" && link.frozen_at === null &&
          Array.isArray(permissions) && permissions.includes("OfferCreate"),
        policyActive: policy !== null,
      };
      observations.set(strategy.strategy_id, observation);
      return observation;
    },

    async build(strategy, decision, idempotencyKey) {
      const observation = observations.get(strategy.strategy_id);
      if (!observation || !decision.proposed_value || decision.action === "hold") throw new Error("fresh quote is required for a build");
      const buying = decision.action === "buy_xrp";
      const drops = amountDrops(decision.proposed_value, buying ? observation.ask : observation.bid);
      const data = record(unwrap(await provider.invoke("tx.swap", {
        network: "testnet",
        account: strategy.mandate.account,
        sell: buying ? strategy.mandate.issued_asset : { currency: "XRP" },
        buy: buying ? { currency: "XRP" } : strategy.mandate.issued_asset,
        amount: drops,
        side: buying ? "buy" : "sell",
        max_slippage_bps: strategy.mandate.limits.max_slippage_bps,
        execution_mode: "fill_or_kill",
        intent_id: decision.decision_id,
        execution_contract: "xrpl_execution_v2",
      })), "tx.swap result is malformed");
      const summary = record(data.summary, "tx.swap summary is malformed");
      const capability = record(data.execution_capability, "v2 execution capability is missing");
      if (typeof data.build_id !== "string" || typeof summary.fee_drops !== "string" ||
          !Number.isSafeInteger(capability.last_ledger_sequence)) {
        throw new Error("tx.swap omitted durable build identity");
      }
      return { buildId: data.build_id, buildRevision: 1,
        lastLedgerSequence: Number(capability.last_ledger_sequence), feeDrops: summary.fee_drops };
    },

    async execute(build, idempotencyKey): Promise<StrategyExecuteResult> {
      let raw: unknown;
      try {
        raw = unwrap(await provider.invoke("tx.execute", {
          build_id: build.buildId,
          idempotency_key: idempotencyKey,
          execution_contract: "xrpl_execution_v2",
          build_revision: build.buildRevision,
        }));
      } catch (error) {
        if ((error as Error & { code?: string }).code === "SUBMISSION_PENDING") return { status: "pending_reconciliation" };
        throw error;
      }
      const result = record(raw, "tx.execute result is malformed");
      if (result.status === "executed" && typeof result.hash === "string") return { status: "executed", txHash: result.hash };
      if (result.status === "needs_approval") return { status: "needs_approval",
        ...(typeof result.approval_id === "string" ? { harborExecutionId: result.approval_id } : {}) };
      if (result.status === "failed" && result.engine_result === "SUBMISSION_PENDING") return { status: "pending_reconciliation" };
      return { status: "failed", detail: typeof result.detail === "string" ? result.detail : "Harbor policy blocked execution" };
    },

    async reconcile(execution: UnresolvedStrategyExecution): Promise<StrategyReconcileResult> {
      if (!execution.buildId) return { status: "pending" };
      if (!input.principal || input.principal.includes(":")) throw new Error("principal is invalid for idempotent execution");
      const durableKey = `${input.principal}:${execution.idempotencyKey}`;
      const receipt = await input.db.prepare(`SELECT status FROM executions
        WHERE principal = ? AND idempotency_key = ? AND build_id = ?`)
        .bind(input.principal, durableKey, execution.buildId).first<{ status: string }>();
      if (!receipt) {
        return { status: "failed", evidence: {
          never_dispatched: true,
          reason: "no Harbor execution receipt exists for the exact build and idempotency identity",
        } };
      }
      let raw: unknown;
      try {
        raw = unwrap(await provider.invoke("tx.execute", {
          build_id: execution.buildId,
          idempotency_key: execution.idempotencyKey,
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
        }));
      } catch (error) {
        if ((error as Error & { code?: string }).code === "SUBMISSION_PENDING") return { status: "pending" };
        throw error;
      }
      const result = record(raw, "tx.execute reconciliation is malformed");
      if (result.status === "executed" && typeof result.hash === "string") {
        return { status: "validated", evidence: { tx_hash: result.hash, durable_status: "executed" } };
      }
      if (result.status === "failed" && result.engine_result === "SUBMISSION_PENDING") return { status: "pending" };
      if (result.status === "needs_approval" && typeof result.approval_id === "string") {
        return { status: "needs_approval", approvalId: result.approval_id };
      }
      if (result.status === "failed" || result.status === "blocked") {
        return { status: "failed", evidence: { durable_status: result.status,
          ...(typeof result.engine_result === "string" ? { engine_result: result.engine_result } : {}) } };
      }
      return { status: "pending" };
    },
  };
}
