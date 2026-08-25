import { hasValidSession, SESSION_COOKIE } from "@auto-harness/shared";
import { NextResponse, type NextRequest } from "next/server";

import { hostPaneUnauthenticatedHtml } from "./lib/unauthenticated.ts";

/** Public host-pane binds must have a signed session before rendering or browsing. */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (process.env.HARNESS_AUTH_MODE !== "required") return NextResponse.next();
  const valid = await hasValidSession(
    request.cookies.get(SESSION_COOKIE)?.value,
    process.env.HARNESS_SESSION_SECRET,
  );
  if (valid) return NextResponse.next();
  return new NextResponse(hostPaneUnauthenticatedHtml(), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
