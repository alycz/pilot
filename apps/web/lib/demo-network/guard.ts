import { isValidClassicAddress } from "xrpl";

export const DEMO_NETWORK_ISSUER_NAME =
  "Demo Network (Mastercard's role in production)";
export const DEMO_NETWORK_UI_LABEL =
  "Demo Network — Mastercard's role in production";
export const AP4M_CREDENTIAL_TYPE = "AP4M-Agent";
export const TESTNET_NETWORK_ID = 1;

export class DemoNetworkError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireDemoNetworkEnabled(env: NodeJS.ProcessEnv): void {
  if (env.AP4M_DEMO_ENABLED !== "true") {
    throw new DemoNetworkError(
      "DEMO_NETWORK_DISABLED",
      404,
      "The AP4M demo network is not enabled.",
    );
  }
  if (env.EXEC_NETWORK !== "testnet") {
    throw new DemoNetworkError(
      "DEMO_NETWORK_REQUIRES_TESTNET",
      404,
      "The AP4M demo network is available only on Testnet.",
    );
  }
}

export function requireTestnetSubject(
  subject: unknown,
  validateAddress: (address: string) => boolean = isValidClassicAddress,
): string {
  if (typeof subject !== "string" || !validateAddress(subject)) {
    throw new DemoNetworkError(
      "INVALID_SUBJECT",
      400,
      "A valid XRPL Testnet subject address is required.",
    );
  }
  return subject;
}

export function requireCredentialType(value: string | undefined): string {
  const credentialType = value?.trim() || AP4M_CREDENTIAL_TYPE;
  if (credentialType !== AP4M_CREDENTIAL_TYPE) {
    throw new DemoNetworkError(
      "DEMO_NETWORK_NOT_CONFIGURED",
      503,
      "The demo network is not configured.",
    );
  }
  return Buffer.from(AP4M_CREDENTIAL_TYPE, "utf8")
    .toString("hex")
    .toUpperCase();
}

export function demoNetworkErrorResponse(error: unknown): Response {
  const safe =
    error instanceof DemoNetworkError
      ? error
      : new DemoNetworkError(
          "DEMO_NETWORK_FAILED",
          502,
          "The demo network request could not be completed.",
        );

  return Response.json(
    { error: { code: safe.code, message: safe.message } },
    {
      status: safe.status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
