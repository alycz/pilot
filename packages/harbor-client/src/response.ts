export const MAX_HARBOR_RESPONSE_BYTES = 1_048_576;
export const MAX_X402_RESPONSE_BYTES = 262_144;

export class HarborResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Harbor response exceeded the ${maxBytes} byte limit`);
    this.name = "HarborResponseTooLargeError";
  }
}

function declaredLength(response: Response, maxBytes: number): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new HarborResponseTooLargeError(maxBytes);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new HarborResponseTooLargeError(maxBytes);
  }
  return parsed;
}

/** Read a response incrementally and stop before retaining more than maxBytes. */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const length = declaredLength(response, maxBytes);
  if (length !== undefined && length > maxBytes) {
    throw new HarborResponseTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HarborResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const encoded = response.headers.get("content-encoding");
  if (length !== undefined && (!encoded || encoded === "identity") && total !== length) {
    throw new HarborResponseTooLargeError(maxBytes);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, maxBytes));
}
