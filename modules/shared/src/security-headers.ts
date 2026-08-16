/**
 * Response headers applied to every route of both control-plane Next.js apps
 * (services/web, services/host-pane). Neither app set any of these before —
 * no CSP, no clickjacking or MIME-sniffing protection, no HSTS — despite both
 * gating destructive actions (cancel session, delete repository, drain host)
 * behind nothing but a same-origin session cookie.
 *
 * The CSP is intentionally not the strictest possible policy: Next.js App
 * Router injects inline `<script>` tags for hydration/RSC streaming, and the
 * shared UI primitives (tooltip/dialog positioning) set inline `style`
 * attributes at runtime, so a bare `'self'` script-src/style-src would break
 * rendering without also wiring a per-request nonce through middleware. This
 * keeps `'unsafe-inline'` for those two directives while still blocking the
 * things a CSP is cheapest insurance against here: loading a script, frame,
 * or object from any third-party origin, and being framed by one.
 *
 * `connect-src` needs one more origin than `'self'`. The browser's live-log
 * viewer (`viewerWebSocketUrl` in services/web) opens its WebSocket directly
 * against the control-plane API's own origin — not through the Next.js
 * rewrite that proxies plain `fetch()` calls same-origin — because a
 * WebSocket upgrade can't be rewritten the way an HTTP request can. That API
 * origin is a different port than the page in every local/e2e layout (7420
 * vs 7421, or 7430 vs 7431 under e2e's port offset), so it is genuinely
 * cross-origin under CSP's same-origin definition even though it's this
 * app's own backend. Each next.config.ts passes its already-computed
 * `apiUpstream` in as `connectSrcOrigins` so this stays derived from the one
 * source of truth instead of a second, driftable copy of the same value.
 */
export function contentSecurityPolicy(
  options: { connectSrcOrigins?: readonly string[] } = {},
): string {
  const connectSrc = ["'self'", ...(options.connectSrcOrigins ?? [])];
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function securityHeaders(
  options: { connectSrcOrigins?: readonly string[] } = {},
): ReadonlyArray<{ key: string; value: string }> {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  ];
}

/** Convert an `http(s)://host:port` origin to its `ws(s)://host:port` equivalent. */
export function wsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/, "ws");
}
