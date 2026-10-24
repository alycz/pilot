export type DemoAction = "settle" | "revoke" | "rogue";

type DemoActionEnvironment = Readonly<{
  NODE_ENV?: string;
  EXEC_NETWORK?: string;
}>;

const LABELS: Record<DemoAction, string> = {
  settle: "Mock-only settlement preview · LIVE Testnet check pending",
  revoke: "Mock-only revocation preview · LIVE Testnet check pending",
  rogue: "Mock-only safety evidence · LIVE Testnet check pending",
};

async function hasRequestBody(request: Request): Promise<boolean> {
  if (request.body === null) return false;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) return contentLength !== "0";

  const reader = request.body.getReader();
  const first = await reader.read();
  if (!first.done || (first.value?.byteLength ?? 0) > 0) {
    await reader.cancel();
    return true;
  }
  return false;
}

/**
 * Dev-only action boundary for the MP6 projector surface.
 *
 * The checked-in adapter deliberately performs no wallet, merchant, Harbor, or
 * ledger I/O. Event-day live adapters are separate work and must remain behind
 * the conductor's LIVE + Testnet gate.
 */
export function createDemoActionHandler(
  action: DemoAction,
  options: {
    env?: DemoActionEnvironment;
    now?: () => Date;
  } = {},
) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
      return Response.json(
        { ok: false, error: { code: "AP4M_DEMO_ACTION_DISABLED" } },
        { status: 404 },
      );
    }
    if (env.EXEC_NETWORK !== "testnet") {
      return Response.json(
        { ok: false, error: { code: "AP4M_DEMO_REQUIRES_TESTNET" } },
        { status: 404 },
      );
    }
    if (new URL(request.url).search !== "") {
      return Response.json(
        { ok: false, error: { code: "AP4M_DEMO_ACTION_QUERY_FORBIDDEN" } },
        { status: 400 },
      );
    }
    if (await hasRequestBody(request)) {
      return Response.json(
        { ok: false, error: { code: "AP4M_DEMO_ACTION_BODY_FORBIDDEN" } },
        { status: 400 },
      );
    }

    const at = now();
    if (!Number.isFinite(at.getTime())) {
      return Response.json(
        { ok: false, error: { code: "AP4M_DEMO_CLOCK_INVALID" } },
        { status: 503 },
      );
    }

    return Response.json({
      ok: true,
      evidence: {
        schema: action === "rogue" ? "ap4m_rogue_v1" : `ap4m_${action}_preview_v1`,
        source: "offline-injected",
        network: "testnet",
        outcome: action === "rogue" ? "rejected" : "previewed",
        engine_result: action === "rogue" ? "tecNO_PERMISSION" : undefined,
        tx_hash: null,
        rogue_address: action === "rogue" ? null : undefined,
        submitted: false,
        verified_live: false,
        at: at.toISOString(),
        label: LABELS[action],
      },
    });
  };
}
