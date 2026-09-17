import {
  CLOUDFRONT_INGRESS_TOKEN_HEADER,
  forwardSentryTunnel,
  isSentryTunnelPath,
} from "@auto-harness/shared";
import { NextResponse, type NextRequest } from "next/server";
import { hasValidSession, loginPath, SESSION_COOKIE } from "./lib/auth-session.ts";

async function hasRemoteSession(request: NextRequest): Promise<boolean> {
  const api = process.env.HARNESS_API_HTTP;
  if (!api) return false;
  const ingressToken = process.env.HARNESS_CLOUDFRONT_INGRESS_TOKEN;
  try {
    const response = await fetch(new URL("api/v1/auth/me", `${api.replace(/\/$/u, "")}/`), {
      headers: {
        cookie: request.headers.get("cookie") ?? "",
        // HARNESS_API_HTTP is the raw API Gateway URL, which bypasses
        // CloudFront and its REQUEST authorizer needs this header to admit
        // the call. Unset locally (host-pane/dev), so no header is sent.
        ...(ingressToken ? { [CLOUDFRONT_INGRESS_TOKEN_HEADER]: ingressToken } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function pass(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/** Public UI binds must have a session before rendering or proxying data. */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (isSentryTunnelPath(request.nextUrl.pathname)) {
    const { status } = await forwardSentryTunnel({
      body: await request.text(),
      configuredDsn: process.env.HARNESS_WEB_SENTRY_DSN_CLIENT,
      method: request.method,
    });
    return new NextResponse(null, { status });
  }
  if (process.env.HARNESS_AUTH_MODE !== "required") return pass(request);
  // A locally valid token can still name an account revoked by the API. Keep
  // login reachable so that stale cookies never trap the browser in a loop.
  if (request.nextUrl.pathname === "/login") return pass(request);
  // Unauthenticated SSR transport probe (services/web/src/app/health/probe/page.tsx) —
  // it must be reachable with no session so its rendered marker proves the server-side
  // apiGet() fetch path itself, not that a caller happened to be logged in. Exact match
  // only: this must not broaden to a prefix, which would leave a whole subtree public.
  if (request.nextUrl.pathname === "/health/probe") return pass(request);
  const valid =
    process.env.HARNESS_WEB_REMOTE_AUTH === "1"
      ? await hasRemoteSession(request)
      : await hasValidSession(
          request.cookies.get(SESSION_COOKIE)?.value,
          process.env.HARNESS_SESSION_SECRET,
        );
  if (valid) return pass(request);
  return NextResponse.redirect(
    new URL(loginPath(`${request.nextUrl.pathname}${request.nextUrl.search}`), request.url),
  );
}

export const config = { matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"] };
