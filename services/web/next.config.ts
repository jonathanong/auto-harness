import type { NextConfig } from "next";

import { securityHeaders, wsOrigin } from "@auto-harness/shared";

const apiUpstream = (
  process.env.HARNESS_API_HTTP ??
  process.env.HARNESS_API_URL ??
  "http://127.0.0.1:7420"
)
  .replace(/\/$/, "")
  .replace(/\/ws$/, "");

// The single source of truth for where the browser's live-log WebSocket actually connects —
// reused for both the baked-in env value below and the CSP connect-src it needs to allow.
// NEXT_PUBLIC_HARNESS_VIEWER_WS_URL, when set, can point at a genuinely different origin
// than apiUpstream (see viewerWebSocketUrl in src/lib/live-session-logs.ts).
const effectiveViewerWsUrl =
  process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL ??
  apiUpstream.replace(/^http/, "ws") + "/ws/viewer";
const cloudBuild = process.env.HARNESS_WEB_CLOUD === "1";

function viewerWsOrigin(): string {
  try {
    return new URL(effectiveViewerWsUrl).origin;
  } catch {
    return wsOrigin(apiUpstream);
  }
}

const nextConfig: NextConfig = {
  ...(cloudBuild
    ? { output: "standalone" }
    : {
        env: {
          NEXT_PUBLIC_HARNESS_VIEWER_WS_URL: effectiveViewerWsUrl,
          // Local-only, same reasoning as the viewer URL above: web (:7421) and the API
          // (:7420 by default) are different origins locally, so a host daemon setup command
          // needs this baked in. Omitted from a cloud build — src/lib/control-plane-url.ts
          // then falls back to window.location.origin, correct because CloudFront serves the
          // web app and the REST/WebSocket API Gateway APIs from the same hostname there.
          NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL: apiUpstream,
        },
      }),
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
    if (cloudBuild) return [];
    return [
      { source: "/api/:path*", destination: `${apiUpstream}/api/:path*` },
      { source: "/health", destination: `${apiUpstream}/health` },
    ];
  },
  async headers() {
    // The live-log viewer's WebSocket (viewerWebSocketUrl in src/lib/live-session-logs.ts)
    // connects directly to effectiveViewerWsUrl's origin, bypassing the rewrite above — a
    // WebSocket upgrade can't be proxied the way a plain fetch() can, and that origin is a
    // different port than this page in every local/e2e layout (or a different host entirely
    // when NEXT_PUBLIC_HARNESS_VIEWER_WS_URL is set), so connect-src needs it explicitly or
    // the browser blocks the connection as cross-origin.
    return [
      {
        source: "/(.*)",
        headers: [...securityHeaders({ connectSrcOrigins: cloudBuild ? [] : [viewerWsOrigin()] })],
      },
    ];
  },
};

export default nextConfig;
