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
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];
