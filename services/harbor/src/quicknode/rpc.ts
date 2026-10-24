import type { Network, RpcRoute } from "../contracts";
import {
  createXrplRpc,
  XrplRpcError,
  type XrplRpc,
  type XrplRpcEnv,
  type XrplRequestOptions,
} from "../adapters/xrpl-rpc";

import coverage from "./coverage.testnet.json";

type QuickNodeMode = "off" | "mock" | "live";
type CoverageStatus =
  | "supported"
  | "supported_business_error"
  | "unsupported";

export type QuickNodeRpcEnv = XrplRpcEnv & {
  QN_MODE?: string;
  QN_XRPL_TESTNET_HTTP?: string;
  XRPL_FALLBACK_TESTNET_HTTP?: string;
};

export type RpcTrust = Readonly<{
  route: RpcRoute;
  methods_quicknode: number;
  methods_fallback: number;
}>;

type XrplCallLog = Readonly<{
  evt: "xrpl_call";
  method: string;
  route: RpcRoute;
  ms: number;
  ok: boolean;
  errCode?: string;
}>;

export type QuickNodeRpcOptions = Readonly<{
  env?: QuickNodeRpcEnv;
  operationName?: string;
  quickNodeRpc?: XrplRpc;
  fallbackRpc?: XrplRpc;
  logger?: (event: XrplCallLog) => void;
  now?: () => number;
}>;

export type QuickNodeRoutedRpc = Readonly<{
  rpc: XrplRpc;
  trust(): RpcTrust;
}>;

const CAPABILITY_ERROR_CODES = new Set([
  "unknownCmd",
  "notSupported",
  "notImpl",
  "reportingUnsupported",
]);

const EXECUTION_CRITICAL_OPERATIONS = new Set([
  "account.link",
  "ap4m.purchase",
  "mandate.prepare",
  "mandate.register",
  "mandate.revoke",
  "tx.ammDeposit",
  "tx.ammWithdraw",
  "tx.execute",
  "tx.offer",
  "tx.offerCancel",
  "tx.payment",
  "tx.simulate",
  "tx.swap",
  "tx.trustSet",
  "tx.vaultDeposit",
  "tx.vaultWithdraw",
  "x402.pay",
]);

const CURRENT_LEDGER_COMMANDS = new Set(["account_info", "account_lines"]);
const TESTNET_COVERAGE = coverage.methods as Readonly<
  Record<string, CoverageStatus>
>;

function quickNodeMode(env: QuickNodeRpcEnv): QuickNodeMode {
  const value = env.QN_MODE?.trim() || "off";
  if (value !== "off" && value !== "mock" && value !== "live") {
    throw new XrplRpcError("Invalid QuickNode mode", "XRPL_INVALID_ENDPOINT");
  }
  return value;
}

function quickNodeEndpoint(env: QuickNodeRpcEnv): string {
  const value = env.QN_XRPL_TESTNET_HTTP?.trim();
  if (!value) {
    throw new XrplRpcError(
      "QuickNode endpoint is required in live mode",
      "XRPL_INVALID_ENDPOINT",
    );
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new XrplRpcError(
      "QuickNode endpoint is invalid",
      "XRPL_INVALID_ENDPOINT",
    );
  }
  return value;
}

function fallbackEnv(env: QuickNodeRpcEnv): XrplRpcEnv {
  const fallback = env.XRPL_FALLBACK_TESTNET_HTTP?.trim();
  return {
    XRPL_MAINNET_URL: env.XRPL_MAINNET_URL,
    XRPL_TESTNET_URL: fallback || env.XRPL_TESTNET_URL,
    XRPL_DEVNET_URL: env.XRPL_DEVNET_URL,
    XRPL_LENDING_DEVNET_URL: env.XRPL_LENDING_DEVNET_URL,
  };
}

function safeRpcErrorCode(error: unknown): string {
  if (!(error instanceof XrplRpcError)) return "XRPL_ERROR";
  return /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(error.code)
    ? error.code
    : "XRPL_ERROR";
}

function isFailoverError(error: unknown): boolean {
  if (!(error instanceof XrplRpcError)) return false;
  if (CAPABILITY_ERROR_CODES.has(error.code)) return true;
  if (
    error.code === "XRPL_TRANSPORT_ERROR" ||
    error.code === "XRPL_TIMEOUT" ||
    error.code === "HTTP_408" ||
    error.code === "HTTP_429"
  ) {
    return true;
  }
  const match = /^HTTP_(\d{3})$/.exec(error.code);
  return match !== null && Number(match[1]) >= 500;
}

function executionParams(
  operationName: string | undefined,
  command: string,
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (
    operationName === undefined ||
    !EXECUTION_CRITICAL_OPERATIONS.has(operationName) ||
    !CURRENT_LEDGER_COMMANDS.has(command) ||
    params?.ledger_index !== "validated"
  ) {
    return params;
  }
  return { ...params, ledger_index: "current" };
}

/** Route one operation's XRPL calls without logging endpoint URLs or params. */
export function createQuickNodeRoutedRpc(
  options: QuickNodeRpcOptions = {},
): QuickNodeRoutedRpc {
  const env = options.env ?? {};
  const mode = quickNodeMode(env);
  const endpoint = mode === "live" ? quickNodeEndpoint(env) : undefined;
  const quickNodeRpc =
    options.quickNodeRpc ??
    (endpoint
      ? createXrplRpc({
          env: { ...fallbackEnv(env), XRPL_TESTNET_URL: endpoint },
        })
      : undefined);
  const fallbackRpc =
    options.fallbackRpc ?? createXrplRpc({ env: fallbackEnv(env) });
  const now = options.now ?? Date.now;
  const logger =
    options.logger ??
    ((event: XrplCallLog): void => console.info("xrpl_call", event));
  let methodsQuickNode = 0;
  let methodsFallback = 0;
  let usedFallback = mode === "off";

  const call = async (
    rpc: XrplRpc,
    route: RpcRoute,
    network: Network,
    command: string,
    params: Readonly<Record<string, unknown>> | undefined,
    requestOptions: XrplRequestOptions | undefined,
  ): Promise<Record<string, unknown>> => {
    const startedAt = now();
    try {
      const result = await rpc.request(network, command, params, requestOptions);
      logger({
        evt: "xrpl_call",
        method: command,
        route,
        ms: Math.max(0, Math.round(now() - startedAt)),
        ok: true,
      });
      return result;
    } catch (error) {
      logger({
        evt: "xrpl_call",
        method: command,
        route,
        ms: Math.max(0, Math.round(now() - startedAt)),
        ok: false,
        errCode: safeRpcErrorCode(error),
      });
      throw error;
    }
  };

  const rpc: XrplRpc = Object.freeze({
    async request(
      network: Network,
      command: string,
      params?: Readonly<Record<string, unknown>>,
      requestOptions?: XrplRequestOptions,
    ) {
      const routedParams = executionParams(
        options.operationName,
        command,
        params,
      );
      if (mode === "off" || network !== "testnet") {
        usedFallback = true;
        const result = await call(
          fallbackRpc, "fallback", network, command, routedParams, requestOptions,
        );
        methodsFallback += 1;
        return result;
      }
      if (mode === "mock") {
        const result = await call(
          fallbackRpc, "quicknode-mock", network, command, routedParams, requestOptions,
        );
        methodsQuickNode += 1;
        return result;
      }
      const coverageStatus = TESTNET_COVERAGE[command];
      if (
        coverageStatus !== "supported" &&
        coverageStatus !== "supported_business_error"
      ) {
        usedFallback = true;
        const result = await call(
          fallbackRpc, "fallback", network, command, routedParams, requestOptions,
        );
        methodsFallback += 1;
        return result;
      }
      if (!quickNodeRpc) {
        throw new XrplRpcError(
          "QuickNode endpoint is unavailable",
          "XRPL_INVALID_ENDPOINT",
        );
      }
      try {
        const result = await call(
          quickNodeRpc, "quicknode", network, command, routedParams, requestOptions,
        );
        methodsQuickNode += 1;
        return result;
      } catch (error) {
        const mayFailOver =
          isFailoverError(error) &&
          !(command === "submit" && safeRpcErrorCode(error) === "HTTP_429");
        if (!mayFailOver) {
          methodsQuickNode += 1;
          throw error;
        }
      }
      usedFallback = true;
      const result = await call(
        fallbackRpc, "fallback", network, command, routedParams, requestOptions,
      );
      methodsFallback += 1;
      return result;
    },
  });

  return Object.freeze({
    rpc,
    trust: () =>
      Object.freeze({
        route: usedFallback
          ? "fallback"
          : mode === "mock"
            ? "quicknode-mock"
            : "quicknode",
        methods_quicknode: methodsQuickNode,
        methods_fallback: methodsFallback,
      }),
  });
}
