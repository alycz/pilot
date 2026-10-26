import type {
  ArgsFor,
  HarborClient,
  NearIntentsDryQuoteResult,
  NearIntentsTokensResult,
} from "@pilot/harbor-client";

type NearReadClient = Pick<HarborClient, "op">;

function errorMessage(envelope: { error?: { message?: string } }, fallback: string): string {
  const message = envelope.error?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export async function loadLiveNearIntentsTokens(
  client: NearReadClient,
): Promise<NearIntentsTokensResult & { source: "live"; live: true }> {
  const envelope = await client.op("near.intents.tokens", { limit: 100 });
  if (!envelope.ok) throw new Error(errorMessage(envelope, "NEAR Intents token discovery is unavailable."));
  if (envelope.data.source !== "live" || envelope.data.live !== true) {
    throw new Error("Harbor returned fixture data; the provider-connected preview remains unavailable.");
  }
  return envelope.data;
}

export async function loadLiveNearIntentsDryQuote(
  client: NearReadClient,
  args: ArgsFor<"near.intents.quote">,
): Promise<NearIntentsDryQuoteResult & { source: "live"; signature_verified: true }> {
  const envelope = await client.op("near.intents.quote", args);
  if (!envelope.ok) throw new Error(errorMessage(envelope, "The NEAR Intents dry quote is unavailable."));
  if (envelope.data.source !== "live" || envelope.data.signature_verified !== true) {
    throw new Error("Harbor returned fixture data; no provider-verified dry quote is available.");
  }
  return envelope.data;
}
