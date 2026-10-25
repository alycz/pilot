import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { Wallet, type Payment } from "xrpl";
import { describe, expect, it } from "vitest";

import {
  digestIssuedApprovalEnvelope,
  type X402IssuedApprovalEnvelopeV1,
} from "../src/exec/x402-issued-offline";

const CURRENCY = "524C555344000000000000000000000000000000";
const RESOURCE_URL = "http://127.0.0.1:8000/api/x402/compare";
const EXTENSION = "pilot.x402.owner-approval";
const MERCHANT_ID = "pilot-x402-issued-merchant-v1";

type JsonLineProcess = Readonly<{
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  next(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}>;

function startMerchant(): JsonLineProcess {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const script = resolve(
    repoRoot,
    "apps/web/api/x402/tests/merchant_subprocess.py",
  );
  const python = process.env.PILOT_X402_PYTHON ?? "python3";
  const inheritedPythonPath = process.env.PYTHONPATH;
  const child = spawn(python, [script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: inheritedPythonPath
        ? `${repoRoot}${delimiter}${inheritedPythonPath}`
        : repoRoot,
      PYTHONDONTWRITEBYTECODE: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return {
    child,
    lines,
    async next() {
      const line = await iterator.next();
      if (line.done) throw new Error(`Python merchant ended early: ${stderr}`);
      return JSON.parse(line.value) as Record<string, unknown>;
    },
    async close() {
      child.stdin.end();
      const code = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", resolveExit);
      });
      lines.close();
      if (code !== 0) throw new Error(`Python merchant exited ${code}: ${stderr}`);
    },
  };
}

function send(process: JsonLineProcess, value: unknown): void {
  process.child.stdin.write(`${JSON.stringify(value)}\n`);
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeBase64Json(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("missing base64 JSON header");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("Harbor to Python issued x402 semantic approval contract", () => {
  it("runs challenge, semantic payment envelope, reconciliation, and resource delivery offline", async () => {
    // Ephemeral wallets exist only in this test process. No seed or private key
    // is persisted, printed, or sent to the Python merchant subprocess.
    const payer = Wallet.generate();
    const payee = Wallet.generate();
    const issuer = Wallet.generate();
    const merchant = startMerchant();
    try {
      send(merchant, {
        payer: payer.classicAddress,
        payTo: payee.classicAddress,
        issuer: issuer.classicAddress,
      });
      const challengeResponse = await merchant.next();
      expect(challengeResponse.status).toBe(402);
      const challenge = challengeResponse.body as Record<string, unknown>;
      expect(decodeBase64Json(challengeResponse.paymentRequired)).toEqual(challenge);
      expect(challenge.extensions).toEqual({
        [EXTENSION]: {
          version: 1,
          required: true,
          domain: EXTENSION,
        },
      });
      const requirement = (challenge.accepts as Record<string, unknown>[])[0];
      const extra = requirement.extra as Record<string, unknown>;
      const invoiceId = extra.invoiceId as string;
      const envelope: X402IssuedApprovalEnvelopeV1 = {
        version: 1,
        domain: "pilot.x402.owner-approval",
        approval_id: "cross-process-approval-0001",
        network: "xrpl:1",
        execution_network: "testnet",
        session_scope: "cross-process-owner-review-0001",
        idempotency_key: "cross-process-payment-0001",
        merchant: {
          id: MERCHANT_ID,
          resource_method: "POST",
          resource_url: RESOURCE_URL,
          pay_to: payee.classicAddress,
        },
        asset: {
          kind: "issued",
          network: "xrpl:1",
          namespace: "token",
          currency: CURRENCY,
          issuer: issuer.classicAddress,
        },
        amount: "0.01",
        owner: payer.classicAddress,
        quote_expires_at: "2026-10-24T12:04:00.000Z",
        merchant_invoice_id: invoiceId,
        transaction: {
          fee_drops: "12",
          sequence: 1,
          last_ledger_sequence: 1014,
          source_tag: 2_610_240,
          validated_ledger_index: 1000,
        },
      };
      const approvalDigest = await digestIssuedApprovalEnvelope(envelope);
      const amount = {
        currency: CURRENCY,
        issuer: issuer.classicAddress,
        value: "0.01",
      };
      const transaction: Payment = {
        TransactionType: "Payment",
        Account: payer.classicAddress,
        Destination: payee.classicAddress,
        Amount: amount,
        SendMax: { ...amount },
        InvoiceID: approvalDigest,
        SourceTag: 2_610_240,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 1014,
      };
      const signed = payer.sign(transaction);
      const paymentSignature = base64Json({
        x402Version: 2,
        resource: challenge.resource,
        accepted: requirement,
        payload: { signedTxBlob: signed.tx_blob },
        extensions: {
          [EXTENSION]: { version: 1, envelope },
        },
      });

      send(merchant, { paymentSignature });
      const paid = await merchant.next();
      expect(paid.status).toBe(200);
      expect(paid.body).toEqual({
        comparison: ["dex", "amm"],
        paymentEvidence: "deterministic-offline-fixture-not-live-validation",
      });
      expect(decodeBase64Json(paid.paymentResponse)).toEqual({
        success: true,
        transaction: signed.hash,
        network: "xrpl:1",
        payer: payer.classicAddress,
        evidenceSource: "deterministic-offline-fixture",
      });

      send(merchant, { paymentSignature });
      const replay = await merchant.next();
      expect(replay).toEqual(paid);
    } finally {
      await merchant.close();
    }
  }, 20_000);
});
