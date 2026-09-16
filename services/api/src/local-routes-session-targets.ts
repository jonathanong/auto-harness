import { thrownMessage } from "@auto-harness/shared";

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
    } catch (error) {
      // Log the cause before the generic 500 — a silent catch here previously hid the same
      // class of storage/IAM failure that made GET /hosts and /workspace-pools unreadable.
      console.error(
        JSON.stringify({
          msg: "session-targets route failure",
          method,
          path: url.pathname,
          error: thrownMessage(error),
        }),
      );
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    }
    return true;
  }
  return false;
}
