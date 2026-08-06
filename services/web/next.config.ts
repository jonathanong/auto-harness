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
  // rewrites() below is baked into the build output at `next build` time — `next start`
  // just serves the frozen result, it does not re-read env vars at runtime. So e2e (which
  // needs a different apiUpstream, :7430 instead of :7420) needs an entirely separate
  // build, not just a different start-time env var. HARNESS_E2E picks a separate distDir
  // for that build to land in, so a normal dev build and an e2e build can coexist on disk
  // without one clobbering the other. See docs/e2e.md.
  ...(process.env.HARNESS_E2E ? { distDir: ".next-e2e" } : {}),
  // Browser calls same origin (/api/v1/…) → Next proxies to control plane (no CORS).
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUpstream}/api/:path*` },
      { source: "/health", destination: `${apiUpstream}/health` },
    ];
  },
};

export default nextConfig;
