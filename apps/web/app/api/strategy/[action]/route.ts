import { createStrategyRouteHandler } from "./handler";

const handle = createStrategyRouteHandler();

export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  return handle(request, (await context.params).action);
}
