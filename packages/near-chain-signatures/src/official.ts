import { chainAdapters, contracts } from "chainsig.js";

import { createNearXrpChainSignaturesAdapter } from "./adapter.js";
import type {
  NearXrpTestnetChainSignaturesAdapter,
  OfficialChainsigXrpPort,
  XrpUnsignedTransaction,
} from "./types.js";

/** Construct the reviewed adapter from Pilot's pinned Testnet values. */
export function createOfficialNearXrpTestnetAdapter(): NearXrpTestnetChainSignaturesAdapter {
  return createNearXrpChainSignaturesAdapter({
    createOfficialXrp: (pinned): OfficialChainsigXrpPort => {
      const contract = new contracts.ChainSignatureContract({
        networkId: pinned.nearNetwork,
        contractId: pinned.contractId,
      });
      const xrp = new chainAdapters.xrp.XRP({
        rpcUrl: pinned.xrpRpcUrl,
        contract,
      });

      const port: OfficialChainsigXrpPort = {
        deriveAddressAndPublicKey: (predecessor, path) =>
          xrp.deriveAddressAndPublicKey(predecessor, path),
        prepareTransactionForSigning: async (request) => {
          const prepared = await xrp.prepareTransactionForSigning(request);
          return {
            transaction: prepared.transaction as unknown as XrpUnsignedTransaction,
            hashesToSign: prepared.hashesToSign,
          };
        },
        serializeTransaction: (transaction) =>
          xrp.serializeTransaction(
            transaction as unknown as Parameters<typeof xrp.serializeTransaction>[0],
          ),
        deserializeTransaction: (serialized) =>
          xrp.deserializeTransaction(serialized) as unknown as XrpUnsignedTransaction,
        finalizeTransactionSigning: (input) =>
          xrp.finalizeTransactionSigning({
            transaction: input.transaction as unknown as Parameters<
              typeof xrp.finalizeTransactionSigning
            >[0]["transaction"],
            rsvSignatures: input.rsvSignatures,
          }),
      };
      return Object.freeze(port);
    },
  });
}
