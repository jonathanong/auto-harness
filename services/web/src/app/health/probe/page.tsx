import { apiGet } from "../../../lib/api.ts";
import { rethrowControlFlowError } from "../../../lib/page-error.ts";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated, server-rendered probe. Proves the web Lambda's server-side
 * apiGet() -> apiBase() -> fetch() path reaches the control-plane API end to end —
 * exactly the path that silently broke during the 2026-09-16 redeploy (#745):
 * apiBase() resolves server-side to HARNESS_API_HTTP, the raw API Gateway URL that
 * bypasses CloudFront, so a dropped CloudFront ingress token 403s every SSR fetch
 * while every page still returns 200. Fetches the unauthenticated `/health` route
 * so no session is needed, and proxy.ts passes this exact path through unauthenticated
 * (see proxy.ts) so the probe itself never redirects to /login.
 *
 * Exposes no data: a boolean-derived marker only, never the fetch error or any
 * response body. Assume this page is reachable by anyone on the CloudFront domain.
 */
export default async function SsrProbePage() {
  const ok = await probeHealthy();
  return (
    <main data-pw={ok ? "probe-ssr-ok" : undefined}>{ok ? "probe: ok" : "probe: unavailable"}</main>
  );
}

async function probeHealthy(): Promise<boolean> {
  try {
    const health = await apiGet<{ ok: boolean }>("/health");
    return health.ok === true;
  } catch (error) {
    // apiGet() calls redirect("/login") on a 401 in HARNESS_AUTH_MODE=required; that (and
    // any other Next control-flow error) must escape uncaught, never collapse into `false`.
    rethrowControlFlowError(error);
    return false;
  }
}
