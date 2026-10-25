/**
 * Where the Pilot docs site (docs-site/, built with Vocs and basePath "/docs")
 * is deployed. When set, Next proxies /docs/* on the Pilot origin to it, so the
 * docs share Pilot's domain. When unset, /docs renders a fallback page.
 *
 * Accepted: an exact HTTPS origin, or an http loopback origin for local work
 * (for example the Vocs dev server). Anything else fails closed at startup.
 */
export const DOCS_PATH = "/docs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resolveDocsOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PILOT_DOCS_ORIGIN must be an absolute origin such as https://docs.pilot.example");
  }

  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error("PILOT_DOCS_ORIGIN must use HTTPS (http is allowed only for loopback hosts)");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("PILOT_DOCS_ORIGIN must be a bare origin with no credentials, path, query or fragment");
  }
  return url.origin;
}

/**
 * The docs router (Waku) requires its base path with a trailing slash, and
 * Next normalizes "/docs/" to "/docs", so the bare path cannot render the docs
 * landing. When docs are configured, "/docs" goes to the first guide page.
 */
export const DOCS_ENTRY_PATH = `${DOCS_PATH}/introduction/what-is-pilot`;

export function docsRedirects(origin: string | undefined) {
  if (!origin) return [];
  return [{ source: DOCS_PATH, destination: DOCS_ENTRY_PATH, permanent: false }];
}

/** Next.js rewrites that mount the docs deployment at /docs. */
export function docsRewrites(origin: string | undefined) {
  if (!origin) return [];
  // Vocs emits /docs-prefixed URLs but its files sit at the deployment root.
  // Pages are requested as their exact index.html so the upstream never answers
  // with a trailing-slash redirect, whose Location would escape the /docs prefix.
  return [
    // Files: assets, RSC payloads (.txt), icons, llms.txt.
    { source: `${DOCS_PATH}/:file(.*\\.[A-Za-z0-9]+)`, destination: `${origin}/:file` },
    // Pages.
    { source: `${DOCS_PATH}/:page+`, destination: `${origin}/:page+/index.html` },
  ];
}
