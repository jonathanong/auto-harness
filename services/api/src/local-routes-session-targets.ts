import { send, type RouteCtx } from "./local-http.ts";

/** Unified session-target picker source (provider accounts + standalone commands). */
export async function handleSessionTargetRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/session-targets") {
    send(res, 200, { items: plane.listSessionTargets() });
    return true;
  }
  return false;
}
