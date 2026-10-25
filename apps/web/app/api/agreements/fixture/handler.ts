import {
  WorkAgreementFixtureError,
  WorkAgreementFixtureService,
  parseWorkAgreementFixtureRequest,
} from "../../../../components/agreements/work-agreement-fixture";

const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export type WorkAgreementFixtureHandlerDependencies = Readonly<{
  enabled?: boolean;
  service?: WorkAgreementFixtureService;
  now?: () => number;
}>;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function boundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new WorkAgreementFixtureError("Fixture request is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new WorkAgreementFixtureError("Fixture request is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkAgreementFixtureError("Fixture request must be valid JSON.");
  }
}

export function createWorkAgreementFixtureHandler(
  dependencies: WorkAgreementFixtureHandlerDependencies = {},
) {
  const enabled = dependencies.enabled ?? false;
  const service = dependencies.service ?? new WorkAgreementFixtureService();
  const now = dependencies.now ?? Date.now;

  return async function POST(request: Request): Promise<Response> {
    if (!enabled) return json(404, { error: "Not found." });
    const url = new URL(request.url);
    if (request.headers.get("origin") !== url.origin) {
      return json(403, { error: "Same-origin fixture access is required." });
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json(415, { error: "Fixture requests require application/json." });
    }
    try {
      const parsed = parseWorkAgreementFixtureRequest(await boundedJson(request));
      return json(200, service.handle(parsed, now()));
    } catch (cause) {
      const message = cause instanceof WorkAgreementFixtureError
        ? cause.message
        : "The fixture rejected an invalid lifecycle transition.";
      return json(400, { error: message });
    }
  };
}
