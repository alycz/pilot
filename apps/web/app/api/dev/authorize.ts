import { authorizeWalletResource } from "../../../lib/wallet-authorization";

export function authorizeDevFundingRequest(
  request: Request,
  account: string,
  network: "testnet" | "devnet",
): boolean {
  return process.env.EXEC_NETWORK === network && authorizeWalletResource(request, account, network);
}
