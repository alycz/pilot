export function resolveMerchantEventsUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;

  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    const local = new URL(candidate, "http://pilot.local");
    return local.search === "" && local.hash === "" ? `${local.pathname}` : undefined;
  }

  try {
    const url = new URL(candidate);
    const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (
      url.protocol !== "http:" ||
      !isLoopback ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
