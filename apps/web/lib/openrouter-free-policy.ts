const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const EXACT_FREE_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}:free$/;

type CatalogModel = Readonly<{
  id?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
}>;

export class OpenRouterFreePolicyError extends Error {
  readonly status = 503;

  constructor(message = "The selected free demo model is not currently verified as zero-price") {
    super(message);
    this.name = "OpenRouterFreePolicyError";
  }
}

function isNumericZero(value: unknown): boolean {
  return typeof value === "string" && /^0(?:\.0+)?$/.test(value);
}

/**
 * OpenRouter's catalog can add price dimensions over time. Require prompt and
 * completion pricing and reject every present non-zero, nested, or unknown
 * value. This deliberately treats conditional overrides as unsafe.
 */
export function isExactZeroPriceCatalogModel(entry: CatalogModel, model: string): boolean {
  if (entry.id !== model || !EXACT_FREE_MODEL_ID.test(model)) return false;
  if (
    !Array.isArray(entry.supported_parameters) ||
    !entry.supported_parameters.includes("tools")
  ) return false;
  if (!entry.pricing || typeof entry.pricing !== "object" || Array.isArray(entry.pricing)) {
    return false;
  }
  const pricing = entry.pricing as Record<string, unknown>;
  if (!isNumericZero(pricing.prompt) || !isNumericZero(pricing.completion)) return false;
  const values = Object.values(pricing);
  return values.length >= 2 && values.every(isNumericZero);
}

export function catalogHasExactZeroPriceModel(payload: unknown, model: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  const matches = data.filter(
    (entry): entry is CatalogModel => Boolean(entry && typeof entry === "object") &&
      (entry as CatalogModel).id === model,
  );
  return matches.length === 1 && isExactZeroPriceCatalogModel(matches[0]!, model);
}

export async function assertCurrentZeroPriceModel(
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OpenRouterFreePolicyError("OpenRouter's free-model catalog is unavailable");
  }
  if (!response.ok) {
    throw new OpenRouterFreePolicyError("OpenRouter's free-model catalog is unavailable");
  }
  if (response.redirected || (
    response.url && response.url !== OPENROUTER_MODELS_URL
  )) {
    throw new OpenRouterFreePolicyError("OpenRouter's free-model catalog redirected unexpectedly");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenRouterFreePolicyError("OpenRouter returned an invalid free-model catalog");
  }
  if (!catalogHasExactZeroPriceModel(payload, model)) throw new OpenRouterFreePolicyError();
}

export const DEMO_OPENROUTER_MODEL_SETTINGS = Object.freeze({
  plugins: [],
  usage: { include: true },
  provider: {
    allow_fallbacks: false,
    require_parameters: true,
    max_price: {
      prompt: 0,
      completion: 0,
      image: 0,
      audio: 0,
      request: 0,
    },
  },
  // Explicitly disable every currently documented paid/default plugin. The
  // operator acceptance gate remains required because organization settings
  // can be locked against request overrides.
  extraBody: {
    plugins: [
      { id: "web", enabled: false },
      { id: "file-parser", enabled: false },
      { id: "response-healing", enabled: false },
      { id: "context-compression", enabled: false },
      { id: "alignment", enabled: false },
      { id: "armor", enabled: false },
      { id: "pareto-router", enabled: false },
    ],
  },
});
