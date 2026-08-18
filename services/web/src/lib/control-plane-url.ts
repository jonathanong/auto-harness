/**
 * The value an operator sets as HARNESS_API_URL on a host daemon to connect it to *this*
 * control plane. Deliberately distinct from resolveServerApiBase() / HARNESS_API_HTTP (see
 * modules/shared/src/api-client.ts): that value is this web app's own server-side backend
 * route to the REST API — on AWS, services/cdk/src/web-stack.ts wires it to the raw
 * RestApiUrl API Gateway hostname, which a host daemon must never be given (see
 * services/host-daemon/src/ws-url.ts, which rejects it outright).
 *
 * The public value a host actually needs is the origin this page itself is being served
 * from: on AWS, CloudFront fronts both the web app and the REST/WebSocket API Gateway APIs
 * under one hostname, so window.location.origin *is* that endpoint — exactly the same
 * reasoning viewerWebSocketUrl (./live-session-logs.ts) already applies to the browser's
 * live-log socket. next.config.ts bakes NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL only for a
 * local (non-cloud) build, where the web app's own origin (:7421) differs from the API's
 * (:7420 by default); it is omitted from a cloud build for exactly this reason.
 */
export function controlPlaneUrl(): string {
  const configured = process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
  if (configured) return configured;
  if (typeof window === "undefined") return "http://127.0.0.1:7420";
  return window.location.origin;
}
