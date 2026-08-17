import { NextResponse, type NextRequest } from "next/server";
import { hasValidSession, loginPath, SESSION_COOKIE } from "./lib/auth-session.ts";

async function hasRemoteSession(request: NextRequest): Promise<boolean> {
  const api = process.env.HARNESS_API_HTTP;
  if (!api) return false;
  try {
    const response = await fetch(new URL("api/v1/auth/me", `${api.replace(/\/$/u, "")}/`), {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Public UI binds must have a session before rendering or proxying data. */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (process.env.HARNESS_AUTH_MODE !== "required") return NextResponse.next();
  // A locally valid token can still name an account revoked by the API. Keep
  // login reachable so that stale cookies never trap the browser in a loop.
  if (request.nextUrl.pathname === "/login") return NextResponse.next();
  const valid =
    process.env.HARNESS_WEB_REMOTE_AUTH === "1"
      ? await hasRemoteSession(request)
      : await hasValidSession(
          request.cookies.get(SESSION_COOKIE)?.value,
          process.env.HARNESS_SESSION_SECRET,
        );
  if (valid) return NextResponse.next();
  return NextResponse.redirect(
    new URL(loginPath(`${request.nextUrl.pathname}${request.nextUrl.search}`), request.url),
  );
}

export const config = { matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"] };
