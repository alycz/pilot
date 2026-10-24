import {
  Client,
  Wallet,
  type CredentialCreate,
  type CredentialDelete,
  type ServerInfoRequest,
  type ServerInfoResponse,
} from "xrpl";

import {
  DemoNetworkError,
  TESTNET_NETWORK_ID,
  requireCredentialType,
} from "./guard";

const TESTNET_ENDPOINT = "wss://s.altnet.rippletest.net:51233";
const RIPPLE_EPOCH_OFFSET_SECONDS = 946_684_800;
const CREDENTIAL_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

type CredentialTransaction = CredentialCreate | CredentialDelete;

export interface DemoNetworkWallet {
  classicAddress: string;
  sign(transaction: CredentialTransaction): { hash: string; tx_blob: string };
}

export interface DemoNetworkClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  request(request: ServerInfoRequest): Promise<ServerInfoResponse>;
  autofill(transaction: CredentialTransaction): Promise<CredentialTransaction>;
  submitAndWait(blob: string): Promise<{
    result: {
      hash: string;
      ledger_index?: number;
      validated?: boolean;
      meta?: string | { TransactionResult?: string };
    };
  }>;
}

export interface CredentialDependencies {
  createClient(endpoint: string): DemoNetworkClient;
  env: NodeJS.ProcessEnv;
  now(): number;
  walletFromSeed(seed: string): DemoNetworkWallet;
}

export interface PublicCredentialResult {
  action: "issued" | "revoked";
  credential_type_hex: string;
  expiration?: number;
  issuer: string;
  ledger_index?: number;
  network: "testnet";
  subject: string;
  tx_hash: string;
  uri?: string;
}

const defaultDependencies: CredentialDependencies = {
  createClient: (endpoint) => new Client(endpoint) as unknown as DemoNetworkClient,
  env: process.env,
  now: Date.now,
  walletFromSeed: (seed) => Wallet.fromSeed(seed) as DemoNetworkWallet,
};

function transactionResult(
  meta: string | { TransactionResult?: string } | undefined,
): string | undefined {
  return typeof meta === "string" ? meta : meta?.TransactionResult;
}

function rippleTime(unixMilliseconds: number): number {
  return Math.floor(unixMilliseconds / 1_000) - RIPPLE_EPOCH_OFFSET_SECONDS;
}

function hexUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function config(dependencies: CredentialDependencies): {
  credentialTypeHex: string;
  endpoint: string;
  seed: string;
} {
  const seed = dependencies.env.DEMO_NETWORK_ISSUER_SEED?.trim();
  if (!seed) {
    throw new DemoNetworkError(
      "DEMO_NETWORK_NOT_CONFIGURED",
      503,
      "The demo network is not configured.",
    );
  }

  return {
    credentialTypeHex: requireCredentialType(
      dependencies.env.AP4M_CREDENTIAL_TYPE,
    ),
    endpoint:
      dependencies.env.XRPL_TESTNET_URL?.trim() || TESTNET_ENDPOINT,
    seed,
  };
}

async function submit(
  transaction: CredentialTransaction,
  dependencies: CredentialDependencies,
): Promise<{
  hash: string;
  issuer: string;
  ledgerIndex?: number;
}> {
  const resolved = config(dependencies);
  let wallet: DemoNetworkWallet;
  try {
    wallet = dependencies.walletFromSeed(resolved.seed);
  } catch {
    throw new DemoNetworkError(
      "DEMO_NETWORK_NOT_CONFIGURED",
      503,
      "The demo network is not configured.",
    );
  }

  const client = dependencies.createClient(resolved.endpoint);
  let connected = false;
  try {
    await client.connect();
    connected = true;

    // server_info network_id prevents a configured endpoint from silently routing
    // credential transactions anywhere except XRPL Testnet.
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/server_info
    const serverInfo = await client.request({ command: "server_info" });
    if (serverInfo.result.info.network_id !== TESTNET_NETWORK_ID) {
      throw new DemoNetworkError(
        "LEDGER_NETWORK_MISMATCH",
        502,
        "The configured XRPL endpoint is not connected to Testnet.",
      );
    }

    const autofilled = await client.autofill({
      ...transaction,
      Account: wallet.classicAddress,
    });
    const signed = wallet.sign(autofilled);
    const submitted = await client.submitAndWait(signed.tx_blob);
    const engineResult = transactionResult(submitted.result.meta);
    if (submitted.result.validated !== true || engineResult !== "tesSUCCESS") {
      throw new DemoNetworkError(
        "CREDENTIAL_TRANSACTION_FAILED",
        502,
        `Credential transaction failed: ${engineResult ?? "not validated"}.`,
      );
    }

    return {
      hash: submitted.result.hash || signed.hash,
      issuer: wallet.classicAddress,
      ...(submitted.result.ledger_index === undefined
        ? {}
        : { ledgerIndex: submitted.result.ledger_index }),
    };
  } finally {
    if (connected) await client.disconnect();
  }
}

export async function issueCredential(
  input: { demoUrl: string; subject: string },
  overrides: Partial<CredentialDependencies> = {},
): Promise<PublicCredentialResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const resolved = config(dependencies);
  const expiration =
    rippleTime(dependencies.now()) + CREDENTIAL_LIFETIME_SECONDS;
  const uri = hexUtf8(input.demoUrl);
  if (uri.length > 256) {
    throw new DemoNetworkError(
      "INVALID_DEMO_URL",
      400,
      "The demo URL is too long for an XRPL Credential URI.",
    );
  }

  // CredentialCreate fields follow XLS-70 and are issuer-signed.
  // https://xrpl.org/docs/references/protocol/transactions/types/credentialcreate
  const submitted = await submit(
    {
      TransactionType: "CredentialCreate",
      Account: "",
      Subject: input.subject,
      CredentialType: resolved.credentialTypeHex,
      Expiration: expiration,
      URI: uri,
    },
    dependencies,
  );

  return {
    action: "issued",
    credential_type_hex: resolved.credentialTypeHex,
    expiration,
    issuer: submitted.issuer,
    ...(submitted.ledgerIndex === undefined
      ? {}
      : { ledger_index: submitted.ledgerIndex }),
    network: "testnet",
    subject: input.subject,
    tx_hash: submitted.hash,
    uri,
  };
}

export async function revokeCredential(
  subject: string,
  overrides: Partial<CredentialDependencies> = {},
): Promise<PublicCredentialResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const resolved = config(dependencies);

  // CredentialDelete is submitted by the issuer with Subject identifying the
  // credential holder. https://xrpl.org/docs/references/protocol/transactions/types/credentialdelete
  const submitted = await submit(
    {
      TransactionType: "CredentialDelete",
      Account: "",
      Subject: subject,
      CredentialType: resolved.credentialTypeHex,
    },
    dependencies,
  );

  return {
    action: "revoked",
    credential_type_hex: resolved.credentialTypeHex,
    issuer: submitted.issuer,
    ...(submitted.ledgerIndex === undefined
      ? {}
      : { ledger_index: submitted.ledgerIndex }),
    network: "testnet",
    subject,
    tx_hash: submitted.hash,
  };
}
