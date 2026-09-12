import { send, type RouteCtx } from "./local-http.ts";
import { sendListPage } from "./local-list-page.ts";

export function sessionTargetListKey(target: { kind: string; id: string }): string {
  return `${target.kind}:${target.id}`;
}

/** Unified session-target picker source (provider accounts + standalone commands). */
export async function handleSessionTargetRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/session-targets") {
    try {
      sendListPage(ctx, await plane.listSessionTargetsDurable(), sessionTargetListKey);
    } catch {
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    }
    return true;
  }
  return false;
}
