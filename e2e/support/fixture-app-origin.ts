const LOOPBACK_HOST = "127.0.0.1";

/**
 * Resolve the one browser origin that an isolated fixture may reach.
 *
 * The value comes from Playwright's active project rather than a second port
 * constant, but remains fail-closed: no TLS downgrade, hostname alias,
 * credentials, path, query, fragment, or implicit port is accepted.
 */
export function resolveFixtureAppOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The isolated fixture requires an explicit local baseURL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The isolated fixture baseURL is invalid");
  }

  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1_024 ||
    port > 65_535
  ) {
    throw new Error(
      "The isolated fixture baseURL must be an explicit uncredentialed 127.0.0.1 HTTP origin",
    );
  }

  return url.origin;
}
