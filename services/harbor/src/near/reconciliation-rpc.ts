import type {
  NearHostedArbitrumUsdcReceiptEvidence,
  NearHostedNativeSourceFundingEvidence,
} from "./attempt-store";

const NEAR_RPC = "https://rpc.mainnet.near.org";
const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,45}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class NearReconciliationRpcError extends Error {
  constructor(readonly code: "INVALID" | "UNKNOWN", message: string) {
    super(message);
    this.name = "NearReconciliationRpcError";
  }
}

export type NearReconciliationRpcPort = Readonly<{
  verifySource(input: Readonly<{
    transactionHash: string;
    sourceAccountId: string;
    depositAccountId: string;
    amountYoctoNear: string;
    verifiedAt: string;
  }>): Promise<NearHostedNativeSourceFundingEvidence>;
  verifyDestination(input: Readonly<{
    transactionHash: string;
    recipient: string;
    minimumAmount: string;
    verifiedAt: string;
  }>): Promise<NearHostedArbitrumUsdcReceiptEvidence>;
}>;

type Fetcher = typeof fetch;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new NearReconciliationRpcError("UNKNOWN", "Trusted RPC request failed");
  if (!response.body) throw new NearReconciliationRpcError("UNKNOWN", "Trusted RPC response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 512_000) {
      await reader.cancel().catch(() => undefined);
      throw new NearReconciliationRpcError("UNKNOWN", "Trusted RPC response was too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch {
    throw new NearReconciliationRpcError("UNKNOWN", "Trusted RPC response was invalid");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NearReconciliationRpcError("UNKNOWN", "Trusted RPC response was invalid");
  }
  return value as Record<string, unknown>;
}

function hexInteger(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new NearReconciliationRpcError("UNKNOWN", `${label} was invalid`);
  }
  return BigInt(value);
}

async function rpc(fetcher: Fetcher, url: string, method: string, params: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "pilot-near-reconcile", method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new NearReconciliationRpcError("UNKNOWN", "Trusted RPC outcome is unknown");
  }
  const envelope = record(await boundedJson(response));
  if (envelope.error !== undefined || envelope.result === undefined) {
    throw new NearReconciliationRpcError("UNKNOWN", "Trusted RPC outcome is unknown");
  }
  return envelope.result;
}

export function createNearReconciliationRpcPort(options: Readonly<{
  nearRpcUrl: string;
  arbitrumRpcUrl: string;
  fetcher?: Fetcher;
}>): NearReconciliationRpcPort {
  if (options.nearRpcUrl !== NEAR_RPC || options.arbitrumRpcUrl !== ARBITRUM_RPC) {
    throw new NearReconciliationRpcError("INVALID", "Reconciliation RPC origins are not the pinned mainnet endpoints");
  }
  const fetcher = options.fetcher ?? fetch;
  return {
    async verifySource(input) {
      if (!NEAR_HASH.test(input.transactionHash) || !/^[a-z0-9._-]{2,64}$/.test(input.sourceAccountId) ||
          !/^[a-z0-9._-]{2,64}$/.test(input.depositAccountId) || !/^[1-9][0-9]*$/.test(input.amountYoctoNear)) {
        throw new NearReconciliationRpcError("INVALID", "Source funding expectation was invalid");
      }
      const tx = record(await rpc(fetcher, NEAR_RPC, "tx", {
        tx_hash: input.transactionHash,
        sender_account_id: input.sourceAccountId,
        wait_until: "FINAL",
      }));
      if (tx.final_execution_status !== "FINAL") throw new NearReconciliationRpcError("UNKNOWN", "NEAR transaction is not final");
      const transactionStatus = record(tx.status);
      if (typeof transactionStatus.SuccessValue !== "string") {
        throw new NearReconciliationRpcError("UNKNOWN", "NEAR transaction did not finalize successfully");
      }
      const transaction = record(tx.transaction);
      const actions = transaction.actions;
      if (transaction.signer_id !== input.sourceAccountId || transaction.receiver_id !== input.depositAccountId ||
          !Array.isArray(actions) || actions.length !== 1) {
        throw new NearReconciliationRpcError("INVALID", "NEAR source transaction does not match the approved transfer");
      }
      const action = record(actions[0]);
      const transfer = record(action.Transfer);
      if (transfer.deposit !== input.amountYoctoNear || Object.keys(action).length !== 1 || Object.keys(transfer).length !== 1) {
        throw new NearReconciliationRpcError("INVALID", "NEAR source transaction is not the exact native transfer");
      }
      const outcomes = tx.receipts_outcome;
      if (!Array.isArray(outcomes)) throw new NearReconciliationRpcError("UNKNOWN", "NEAR receipt evidence is unavailable");
      const matching = outcomes.map(record).filter((item) => {
        const outcome = record(item.outcome);
        const status = record(outcome.status);
        return outcome.executor_id === input.depositAccountId && typeof status.SuccessValue === "string";
      });
      if (matching.length !== 1) throw new NearReconciliationRpcError("UNKNOWN", "NEAR receipt evidence is ambiguous");
      const receipt = matching[0];
      const blockHash = receipt.block_hash;
      if (typeof receipt.id !== "string" || !NEAR_HASH.test(receipt.id) || typeof blockHash !== "string" || !NEAR_HASH.test(blockHash)) {
        throw new NearReconciliationRpcError("UNKNOWN", "NEAR receipt identity is invalid");
      }
      const block = record(await rpc(fetcher, NEAR_RPC, "block", { block_id: blockHash }));
      const header = record(block.header);
      const height = header.height;
      const nanos = header.timestamp_nanosec;
      if (!Number.isSafeInteger(height) || (height as number) < 1 || typeof nanos !== "string" || !/^[1-9][0-9]*$/.test(nanos)) {
        throw new NearReconciliationRpcError("UNKNOWN", "NEAR finalized block metadata is invalid");
      }
      const includedAt = new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
      if (Date.parse(includedAt) > Date.parse(input.verifiedAt)) throw new NearReconciliationRpcError("UNKNOWN", "NEAR block time is in the future");
      return {
        version: "pilot-near-native-near-source-funding-v1",
        provenance: "near-rpc-finalized-native-transfer",
        network: "near:mainnet",
        transaction_hash: input.transactionHash,
        receipt_id: receipt.id,
        block_height: height as number,
        finality: "final",
        execution_status: "SUCCESS",
        source_account_id: input.sourceAccountId,
        receiver_account_id: input.depositAccountId,
        amount_yocto_near: input.amountYoctoNear,
        included_at: includedAt,
        verified_at: input.verifiedAt,
      };
    },
    async verifyDestination(input) {
      if (!EVM_HASH.test(input.transactionHash) || !EVM_ADDRESS.test(input.recipient) || !/^[1-9][0-9]*$/.test(input.minimumAmount)) {
        throw new NearReconciliationRpcError("INVALID", "Destination expectation was invalid");
      }
      const receipt = record(await rpc(fetcher, ARBITRUM_RPC, "eth_getTransactionReceipt", [input.transactionHash]));
      if (receipt.transactionHash?.toString().toLowerCase() !== input.transactionHash.toLowerCase() || receipt.status !== "0x1") {
        throw new NearReconciliationRpcError("UNKNOWN", "Arbitrum receipt is missing or unsuccessful");
      }
      const blockNumber = hexInteger(receipt.blockNumber, "Arbitrum block number");
      const finalized = record(await rpc(fetcher, ARBITRUM_RPC, "eth_getBlockByNumber", ["finalized", false]));
      if (blockNumber > hexInteger(finalized.number, "Arbitrum finalized block")) {
        throw new NearReconciliationRpcError("UNKNOWN", "Arbitrum receipt is not finalized");
      }
      const recipientTopic = `0x${input.recipient.slice(2).toLowerCase().padStart(64, "0")}`;
      const logs = Array.isArray(receipt.logs) ? receipt.logs.map(record) : [];
      const matching = logs.filter((log) => {
        const topics = Array.isArray(log.topics) ? log.topics : [];
        try {
          return log.removed !== true && log.address?.toString().toLowerCase() === USDC && topics.length === 3 &&
            topics[0]?.toString().toLowerCase() === TRANSFER_TOPIC && topics[2]?.toString().toLowerCase() === recipientTopic &&
            hexInteger(log.data, "USDC transfer amount") >= BigInt(input.minimumAmount);
        } catch { return false; }
      });
      if (matching.length !== 1) throw new NearReconciliationRpcError("UNKNOWN", "Canonical USDC delivery evidence is missing or ambiguous");
      const log = matching[0];
      const topics = log.topics as unknown[];
      const sender = `0x${String(topics[1]).slice(-40).toLowerCase()}`;
      const blockHash = String(receipt.blockHash);
      if (!EVM_HASH.test(blockHash) || !EVM_ADDRESS.test(sender)) throw new NearReconciliationRpcError("UNKNOWN", "Arbitrum receipt identity is invalid");
      const blockNumberValue = Number(blockNumber);
      const transactionIndex = Number(hexInteger(receipt.transactionIndex, "Arbitrum transaction index"));
      const logIndex = Number(hexInteger(log.logIndex, "Arbitrum log index"));
      if (!Number.isSafeInteger(blockNumberValue) || !Number.isSafeInteger(transactionIndex) || !Number.isSafeInteger(logIndex)) {
        throw new NearReconciliationRpcError("UNKNOWN", "Arbitrum receipt indexes exceed safe bounds");
      }
      return {
        version: "pilot-near-arbitrum-canonical-usdc-receipt-v1",
        provenance: "arbitrum-rpc-finalized-erc20-transfer",
        chain: "arb",
        chain_id: 42161,
        transaction_hash: input.transactionHash.toLowerCase(),
        block_hash: blockHash.toLowerCase(),
        block_number: blockNumberValue,
        transaction_index: transactionIndex,
        log_index: logIndex,
        finality: "final",
        receipt_status: "success",
        event_signature: "Transfer(address,address,uint256)",
        token_contract: USDC,
        token_decimals: 6,
        sender_address: sender,
        recipient_address: input.recipient.toLowerCase(),
        amount_received: hexInteger(log.data, "USDC transfer amount").toString(),
        verified_at: input.verifiedAt,
      };
    },
  };
}
