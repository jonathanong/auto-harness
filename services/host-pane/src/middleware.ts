import { NextResponse, type NextRequest } from "next/server";

/** Public host-pane binds must have a session before rendering or browsing. */
export function middleware(request: NextRequest): NextResponse {
  if (process.env.HARNESS_AUTH_MODE !== "required") return NextResponse.next();
  if (request.cookies.has("auto_harness_session")) return NextResponse.next();
  return new NextResponse("authentication required", { status: 401 });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
