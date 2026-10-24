export const X402_LOCAL_HARBOR_URL = "http://127.0.0.1:8791" as const;
export const X402_ISOLATED_HARBOR_URL = "http://127.0.0.2:8792" as const;

/** Accept only the reviewed local worker origin at its normalized root path. */
export function isExactLocalX402HarborUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const raw = value.trim();
    if (raw !== X402_LOCAL_HARBOR_URL && raw !== `${X402_LOCAL_HARBOR_URL}/`) return false;
    const url = new URL(raw);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "8791" &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === X402_LOCAL_HARBOR_URL;
  } catch {
    return false;
  }
}

/** Accept only the dedicated isolated x402 worker origin. */
export function isExactIsolatedLocalX402HarborUrl(
  value: string | undefined,
): boolean {
  if (!value) return false;
  try {
    const raw = value.trim();
    if (raw !== X402_ISOLATED_HARBOR_URL) return false;
    const url = new URL(raw);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.2" &&
      url.port === "8792" &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === X402_ISOLATED_HARBOR_URL;
  } catch {
    return false;
  }
}
