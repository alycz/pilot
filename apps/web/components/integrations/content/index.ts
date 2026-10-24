import { awsIntegration } from "./aws";
import { ledgerExplainer } from "./ledger";
import { mastercardIntegration } from "./mastercard";
import { quickNodeExplainer } from "./quicknode";

export const integrationExplainers = {
  mastercard: mastercardIntegration,
  aws: awsIntegration,
  quicknode: quickNodeExplainer,
  ledger: ledgerExplainer,
} as const;

export {
  awsIntegration,
  ledgerExplainer,
  mastercardIntegration,
  quickNodeExplainer,
};
