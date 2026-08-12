import type { IncomingMessage, ServerResponse } from "node:http";

import { type AuthService, type Principal } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";
import { readJson, send } from "./local-http.ts";

export type SelfServiceAuthRouteContext = {
  auth: AuthService;
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  principal?: Principal;
};

/** Current-account and password-change routes, authenticated by the local server. */
export async function handleSelfServiceAuthRoutes(
  ctx: SelfServiceAuthRouteContext,
): Promise<boolean> {
  const { auth, plane, req, res, url, method } = ctx;
  if (method === "GET" && url.pathname === "/api/v1/auth/me") {
    if (!ctx.principal) {
      send(res, 401, { error: { code: "UNAUTHENTICATED", message: "authentication required" } });
      return true;
    }
    send(res, 200, ctx.principal);
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/auth/viewer-ticket") {
    if (!ctx.principal) {
      if (auth.mode === "disabled") {
        send(res, 200, { ticket: null });
        return true;
      }
      send(res, 401, { error: { code: "UNAUTHENTICATED", message: "authentication required" } });
      return true;
    }
    send(res, 200, { ticket: auth.issueViewerTicket(ctx.principal) });
    return true;
  }
  if (method !== "PUT" || url.pathname !== "/api/v1/auth/password") return false;
  if (!ctx.principal) {
    send(res, 401, { error: { code: "UNAUTHENTICATED", message: "authentication required" } });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      throw new Error("currentPassword and newPassword are required");
    }
  } catch (error) {
    send(res, 400, {
      error: {
        code: "VALIDATION_ERROR",
        message: error instanceof Error ? error.message : "invalid password change",
      },
    });
    return true;
  }
  try {
    const result = await auth.changePassword(
      ctx.principal,
      body.currentPassword as string,
      body.newPassword as string,
      plane.state.storage,
    );
    if (result === "changed") {
      auth.issueCookie(res, ctx.principal);
      send(res, 200, { principal: ctx.principal });
    } else if (result === "invalid-current-password") {
      send(res, 401, {
        error: { code: "INVALID_CREDENTIALS", message: "current password is incorrect" },
      });
    } else if (result === "invalid-new-password") {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "new password is invalid" },
      });
    } else if (result === "unsupported-account") {
      send(res, 403, {
        error: {
          code: "UNSUPPORTED_ACCOUNT",
          message: "password changes are only available to user accounts",
        },
      });
    } else if (result === "missing-account") {
      send(res, 404, { error: { code: "NOT_FOUND", message: "user account not found" } });
    } else {
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "password change failed" } });
    }
  } catch {
    send(res, 500, { error: { code: "INTERNAL_ERROR", message: "password change failed" } });
  }
  return true;
}
