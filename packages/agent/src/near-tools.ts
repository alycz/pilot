import {
  Near1ClickDryQuoteRequestSchema,
  Near1ClickDryQuoteResponseSchema,
  type Near1ClickDryQuoteRequest,
  type Near1ClickDryQuoteResponse,
  type Near1ClickStatusResponse,
  type Near1ClickToken,
} from "@pilot/contracts";

export type VerifiedNearDryQuote = Readonly<{
  response: Near1ClickDryQuoteResponse;
  providerSignatureVerified: true;
}>;
export type NearSettlementReference = Readonly<{ depositAddress: string; depositMemo?: string }>;
export type NearSettlementObservation = Readonly<Pick<
  Near1ClickStatusResponse,
  "status" | "correlationId" | "updatedAt"
>>;

export type NearReadOnlyToolDependencies = Readonly<{
  listTokens(signal?: AbortSignal): Promise<readonly Near1ClickToken[]>;
  requestDryQuote(
    input: Near1ClickDryQuoteRequest,
    signal?: AbortSignal,
  ): Promise<VerifiedNearDryQuote>;
  readStatus?(reference: NearSettlementReference, signal?: AbortSignal): Promise<NearSettlementObservation>;
  viewAccount?(accountId: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}>;

function settlementReference(value: NearSettlementReference): NearSettlementReference {
  const depositAddress = value.depositAddress.trim();
  const depositMemo = value.depositMemo?.trim();
  if (!depositAddress || depositAddress.length > 512) throw new Error("depositAddress is invalid");
  if (depositMemo !== undefined && (!depositMemo || depositMemo.length > 512)) {
    throw new Error("depositMemo is invalid");
  }
  return Object.freeze({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
}

/** Read-only tokens -> verified dry quote -> optional existing status observation. */
export async function discoverNearEarn(
  input: Readonly<{
    quoteRequest: Near1ClickDryQuoteRequest;
    observe?: NearSettlementReference;
  }>,
  dependencies: NearReadOnlyToolDependencies,
  signal?: AbortSignal,
): Promise<Readonly<{
  mode: "read-only-dry-quote";
  executable: false;
  quote: VerifiedNearDryQuote;
  settlement?: NearSettlementObservation;
  caveats: readonly string[];
}>> {
  const request = Near1ClickDryQuoteRequestSchema.parse(input.quoteRequest);
  const tokens = await dependencies.listTokens(signal);
  const supported = new Set(tokens.map((token) => token.assetId));
  if (!supported.has(request.originAsset) || !supported.has(request.destinationAsset)) {
    throw new Error("Both assets must use exact ids returned by the current 1Click token list");
  }
  const quote = await dependencies.requestDryQuote(request, signal);
  const parsedResponse = Near1ClickDryQuoteResponseSchema.safeParse(quote.response);
  if (!parsedResponse.success) {
    throw new Error("The verified 1Click dry quote does not match the requested discovery scope");
  }
  const response = parsedResponse.data;
  const providerRequest = Near1ClickDryQuoteRequestSchema.parse(response.quoteRequest);
  if (
    quote.providerSignatureVerified !== true ||
    JSON.stringify(providerRequest) !== JSON.stringify(request)
  ) {
    throw new Error("The verified 1Click dry quote does not match the requested discovery scope");
  }
  const verifiedQuote = Object.freeze({ response, providerSignatureVerified: true as const });

  let settlement: NearSettlementObservation | undefined;
  if (input.observe) {
    if (!dependencies.readStatus) throw new Error("Settlement status observation is not configured");
    settlement = await dependencies.readStatus(settlementReference(input.observe), signal);
  }
  return Object.freeze({
    mode: "read-only-dry-quote",
    executable: false,
    quote: verifiedQuote,
    ...(settlement ? { settlement } : {}),
    caveats: Object.freeze([
      "This is a provider-signature-verified dry quote, not a completed swap or executable authorization.",
      "Execution requires a fresh executable quote, exact approval, and a separately enabled adapter.",
    ]),
  });
}

export async function readNearAccount(
  accountId: string,
  dependencies: NearReadOnlyToolDependencies,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  if (!dependencies.viewAccount) throw new Error("NEAR account reads are not configured");
  if (accountId.length < 2 || accountId.length > 64 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(accountId)) {
    throw new Error("A valid NEAR account id is required");
  }
  return dependencies.viewAccount(accountId, signal);
}

