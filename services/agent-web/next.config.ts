import type { NextConfig } from "next";

const apiUpstream = (
  process.env.HARNESS_API_HTTP ??
  process.env.HARNESS_API_URL ??
  "http://127.0.0.1:7420"
)
  .replace(/\/$/, "")
  .replace(/\/ws$/, "");

const nextConfig: NextConfig = {
  transpilePackages: ["@auto-harness/ui", "@auto-harness/shared"],
  experimental: {
    externalDir: true,
  },
  // Browser calls same origin (/api/v1/…) → Next proxies to control plane (no CORS).
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUpstream}/api/:path*` },
      { source: "/health", destination: `${apiUpstream}/health` },
    ];
  },
};

export default nextConfig;
