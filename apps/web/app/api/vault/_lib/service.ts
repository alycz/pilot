import { createVaultFromEnv, type VaultService } from "@pilot/vault";

let service: VaultService | undefined;

type HarborClientModule = {
  createHarborRestClient(options: { mock: true }): {
    op(name: any, args: any): Promise<any>;
  };
};

let policyClientPromise: Promise<ReturnType<HarborClientModule["createHarborRestClient"]>> | undefined;

function policyClient() {
  policyClientPromise ??= (async () => {
    const harborPackage: string = "@pilot/harbor-client";
    const module = (await import(harborPackage)) as HarborClientModule;
    return module.createHarborRestClient({ mock: true });
  })();
  return policyClientPromise;
}

/** Server-only singleton; the Harbor key and vault token never enter route responses. */
export function getVaultService(): VaultService {
  if (service) return service;
  service = createVaultFromEnv(undefined, async ({ owner, network, policy }) => {
    // P-core is deliberately fixture-backed. This is the policy.set mock call;
    // P-live replaces it with the server-side Harbor route without changing vault code.
    if (process.env.HARBOR_MOCK !== "1") {
      throw new Error("Vault policy sync requires HARBOR_MOCK=1 in P-core");
    }
    const result = await (await policyClient()).op("policy.set", {
      owner,
      network,
      policy,
    });
    if (!result.ok) throw new Error(result.error?.message ?? "Harbor policy.set failed");
  });
  return service;
}
