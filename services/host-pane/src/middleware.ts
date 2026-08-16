import { hasValidSession, SESSION_COOKIE } from "@auto-harness/shared";
import { NextResponse, type NextRequest } from "next/server";

/** Public host-pane binds must have a signed session before rendering or browsing. */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (process.env.HARNESS_AUTH_MODE !== "required") return NextResponse.next();
  const valid = await hasValidSession(
    request.cookies.get(SESSION_COOKIE)?.value,
    process.env.HARNESS_SESSION_SECRET,
  );
  if (valid) return NextResponse.next();
  return new NextResponse("authentication required", { status: 401 });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
