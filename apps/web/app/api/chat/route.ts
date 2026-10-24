import { createChatHandler } from "./handler";
import { maybeHandlePersonalizationFixtureChat } from "./personalization-fixture";
import { createHermesRuntimeAdvisorFactoryFromEnvironment } from "../../../lib/hermes-runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const chatHandler = createChatHandler({
  hermesWorkflowAdvisorForRequest:
    createHermesRuntimeAdvisorFactoryFromEnvironment(process.env),
});

export async function POST(request: Request): Promise<Response> {
  const fixtureResponse = await maybeHandlePersonalizationFixtureChat(request.clone());
  return fixtureResponse ?? chatHandler(request);
}
