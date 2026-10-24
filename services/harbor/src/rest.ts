import type { OpContext } from "./catalog/registry";
import { OpRegistry } from "./catalog/registry";
import { createHarborProvider } from "./executor/providers";
import { errorEnvelope } from "./guard";

export type RestContext = OpContext & {
	db?: D1Database;
	request?: Request;
};

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
export async function handleRestOperation(
	request: Request,
	opName: string,
	ctx: RestContext,
	registry: OpRegistry,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { allow: "POST" },
		});
	}

	const op = registry.get(opName);
	if (!op) {
		return json(
			errorEnvelope(opName, new Error(`Unknown operation: ${opName}`), {
				code: "UNKNOWN_OPERATION",
			}),
			404,
		);
	}

	let args: unknown;
	try {
		args = await request.json();
	} catch {
		return json(
			errorEnvelope(opName, new Error("Request body must be valid JSON"), {
				code: "INVALID_JSON",
			}),
			400,
		);
	}

	try {
		const envelope = await createHarborProvider(registry, ctx).invoke(
			op.name,
			args,
		);
		return json(envelope);
	} catch {
		return json(
			errorEnvelope(op.name, new Error("Operation failed"), {
				code: "OPERATION_FAILED",
			}),
		);
	}
}
