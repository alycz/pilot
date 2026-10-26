import type { NextConfig } from "next";

import { docsRedirects, docsRewrites, resolveDocsOrigin } from "./lib/docs-origin";

// Validated at startup: an invalid value fails the build instead of proxying somewhere unexpected.
const docsOrigin = resolveDocsOrigin(process.env.PILOT_DOCS_ORIGIN);

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.2"],
  reactStrictMode: true,
  // Dev-only badge; bottom-left belongs to the Ask Pilot button.
  devIndicators: { position: "bottom-right" },
  outputFileTracingIncludes: {
    "/api/chat": ["./node_modules/undici/**/*"],
  },
  transpilePackages: ["@pilot/harbor-client"],
  async redirects() {
    return docsRedirects(docsOrigin);
  },
  async rewrites() {
    // beforeFiles so a configured docs deployment takes precedence over the
    // app/docs fallback page.
    return { beforeFiles: docsRewrites(docsOrigin), afterFiles: [], fallback: [] };
  },
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
