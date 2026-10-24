import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { readPilotAwsConfig } from "@/lib/aws/config";

export const metadata = {
  title: "Set up the workspace",
  description: "Connect model access and a testnet budget wallet without sharing an owner key.",
};

export default function OnboardingPage() {
  const { bedrockMode, bedrockModels } = readPilotAwsConfig();
  const harborAudience =
    process.env.AP4M_HARBOR_AUDIENCE?.trim() || "https://harbor.mock";

  return (
    <OnboardingFlow
      bedrockMode={bedrockMode}
      bedrockModels={bedrockModels}
      harborAudience={harborAudience}
    />
  );
}
