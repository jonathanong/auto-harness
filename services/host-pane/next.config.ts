import type { NextConfig } from "next";

import { securityHeaders, wsOrigin } from "@auto-harness/shared";

const apiUpstream = (
  process.env.HARNESS_API_HTTP ??
  process.env.HARNESS_API_URL ??
  "http://127.0.0.1:7420"
)
  .replace(/\/$/, "")
  .replace(/\/ws$/, "");

// Mirrors services/web/next.config.ts's derivation so both apps' CSP stay in lockstep —
// host-pane has no browser WebSocket of its own today, but if NEXT_PUBLIC_HARNESS_VIEWER_WS_URL
// is ever set here too, connect-src should reflect it rather than only apiUpstream.
const effectiveViewerWsUrl =
  process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL ??
  apiUpstream.replace(/^http/, "ws") + "/ws/viewer";

function viewerWsOrigin(): string {
  try {
    return new URL(effectiveViewerWsUrl).origin;
  } catch {
    return wsOrigin(apiUpstream);
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ["@auto-harness/ui", "@auto-harness/shared"],
  reactCompiler: true,
  experimental: {
    externalDir: true,
  },
  // CI has a separate required Typecheck job covering every workspace package. Avoid
  // repeating that work inside production-mode E2E builds; deploy/normal builds still fail
  // on type errors.
  typescript: { ignoreBuildErrors: process.env.HARNESS_E2E === "1" },
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
  async headers() {
    // host-pane has no browser WebSocket of its own today, but it computes the same
    // effectiveViewerWsUrl as services/web and shares the same control-plane API — allowing
    // it here keeps both apps' CSP derived from one source rather than drifting if
    // host-pane ever needs a direct connection too.
    return [
      {
        source: "/(.*)",
        headers: [...securityHeaders({ connectSrcOrigins: [viewerWsOrigin()] })],
      },
    ];
  },
};

export default nextConfig;
