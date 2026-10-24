import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.2"],
  reactStrictMode: true,
  // Dev-only badge; bottom-left belongs to the Ask Pilot button.
  devIndicators: { position: "bottom-right" },
  transpilePackages: ["@pilot/harbor-client"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
