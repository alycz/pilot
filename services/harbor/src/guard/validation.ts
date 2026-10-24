import { z } from "zod";

import { GuardError } from "./error";

export function validateArguments<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  throw new GuardError(`Invalid operation arguments: ${issues}`, "INVALID_ARGUMENTS");
}
