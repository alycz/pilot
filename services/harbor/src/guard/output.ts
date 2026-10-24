import { GuardError } from "./error";

export const MAX_OUTPUT_BYTES = 24 * 1024;
const TRUNCATION_MARKER = "\n… [output truncated]";
const encoder = new TextEncoder();

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "null";
  } catch {
    throw new GuardError(
      "Operation output could not be serialized",
      "OUTPUT_SERIALIZATION_FAILED",
    );
  }
}

/**
 * Serializes and caps executor transport text. A truncated structured value is
 * deliberately plain text with a marker, not a JSON/REST response body.
 */
export function truncateOutput(
  value: unknown,
  maxBytes = MAX_OUTPUT_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  const output = serialize(value);
  const bytes = encoder.encode(output);
  if (bytes.byteLength <= maxBytes) return output;

  const markerBytes = encoder.encode(TRUNCATION_MARKER);
  if (maxBytes <= markerBytes.byteLength) {
    return new TextDecoder().decode(markerBytes.slice(0, maxBytes), {
      stream: true,
    });
  }

  const available = maxBytes - markerBytes.byteLength;
  // Streaming decode intentionally drops an incomplete final code point, so
  // truncation never emits malformed UTF-8 or exceeds the byte budget.
  const prefix = new TextDecoder().decode(bytes.slice(0, available), {
    stream: true,
  });
  return prefix + TRUNCATION_MARKER;
}
