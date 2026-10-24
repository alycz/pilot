import type { Envelope } from "../contracts";
import type { OpContext, OpDef } from "../catalog/registry";
import { okEnvelope, type EnvelopeMetadata } from "./envelope";
import { assertSafeArguments, assertSafeCode } from "./secrets";
import { validateArguments } from "./validation";

export { GuardError } from "./error";
export {
  errorEnvelope,
  isEnvelope,
  okEnvelope,
  type EnvelopeMetadata,
} from "./envelope";
export { MAX_OUTPUT_BYTES, truncateOutput } from "./output";
export {
  assertSafeArguments,
  assertSafeCode,
  containsSensitiveFragment,
} from "./secrets";
export { validateArguments } from "./validation";

export async function invokeOp<TArgs extends import("zod").z.ZodTypeAny, TResult>(
  op: OpDef<TArgs, TResult>,
  ctx: OpContext,
  input: unknown,
  metadata: Omit<EnvelopeMetadata, "caveat">,
): Promise<Envelope<Awaited<TResult>>> {
  assertSafeArguments(input);
  const args = validateArguments(op.args, input);
  const data = await op.handler(ctx, args);
  return okEnvelope(data, {
    ...metadata,
    caveat: op.caveats,
  }) as Envelope<Awaited<TResult>>;
}

export function guardCode(code: string): string {
  assertSafeCode(code);
  return code;
}
