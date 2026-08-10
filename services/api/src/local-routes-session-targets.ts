import { send, type RouteCtx } from "./local-http.ts";

/** Unified session-target picker source (provider accounts + standalone commands). */
export async function handleSessionTargetRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/session-targets") {
    try {
      send(res, 200, { items: await plane.listSessionTargetsDurable() });
    } catch {
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    }
    return true;
  }
  return false;
}
