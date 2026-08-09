import { NextResponse, type NextRequest } from "next/server";

/** Public UI binds must have a session before rendering or proxying data. */
export function middleware(request: NextRequest): NextResponse {
  if (process.env.HARNESS_AUTH_MODE !== "required") return NextResponse.next();
  if (request.cookies.has("auto_harness_session")) return NextResponse.next();
  return new NextResponse("authentication required", { status: 401 });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
