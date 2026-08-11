import type { IncomingMessage, ServerResponse } from "node:http";

import { auditActor } from "./audit.ts";
import { validateCredential } from "./auth-accounts.ts";
import type { AuthService, Principal, Role } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";
import { readJson, send } from "./local-http.ts";

type AccountRouteCtx = {
  auth: AuthService;
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  principal?: Principal;
};

async function audit(
  ctx: AccountRouteCtx,
  action: string,
  resourceType: string,
  resourceId: string,
  outcome: "success" | "failed",
): Promise<boolean> {
  try {
    await ctx.plane.appendAuditLog({
      actor: auditActor(ctx.principal),
      action,
      resourceType,
      resourceId,
      outcome,
    });
    return true;
  } catch {
    send(ctx.res, 500, {
      error: { code: "INTERNAL_ERROR", message: "unable to persist control-plane state" },
    });
    return false;
  }
}

export async function handleAccountRoutes(ctx: AccountRouteCtx): Promise<boolean> {
  const { auth, plane, req, res, url, method } = ctx;
  if (url.pathname === "/api/v1/auth/users") {
    if (method === "GET") return (send(res, 200, { items: auth.listUsers() }), true);
    if (method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.username !== "string" ||
          typeof body.password !== "string" ||
          !isRole(body.role)
        )
          throw new Error("username, password, and role are required");
        validateCredential(body.username, "username");
        validateCredential(body.password, "password");
      } catch (error) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: error instanceof Error ? error.message : "invalid account",
          },
        });
        return true;
      }
      try {
        const user = await auth.createUser(
          { username: body.username, password: body.password, role: body.role },
          plane.state.storage,
        );
        if (!(await audit(ctx, "user:create", "user", user.id, "success"))) return true;
        send(res, 201, user);
      } catch (error) {
        if (!(await audit(ctx, "user:create", "user", "new", "failed"))) return true;
        const conflict = error instanceof Error && error.message === "username already exists";
        send(res, conflict ? 409 : 500, {
          error: {
            code: conflict ? "CONFLICT" : "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "internal server error",
          },
        });
      }
      return true;
    }
  }
  const userMatch = /^\/api\/v1\/auth\/users\/([^/]+)$/.exec(url.pathname);
  if (userMatch && method === "DELETE") {
    const id = decodeURIComponent(userMatch[1]!);
    const removed = await auth.deleteUser(id, plane.state.storage);
    if (!(await audit(ctx, "user:delete", "user", id, removed ? "success" : "failed"))) return true;
    send(
      res,
      removed ? 204 : 404,
      removed ? null : { error: { code: "NOT_FOUND", message: "user not found" } },
    );
    return true;
  }
  if (url.pathname === "/api/v1/auth/service-accounts") {
    if (method === "GET") return (send(res, 200, { items: auth.listServiceAccounts() }), true);
    if (method === "POST") {
      let body: Record<string, unknown>;
      let rawRepositories: unknown;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.name !== "string" ||
          !isRole(body.role)
        )
          throw new Error("name and role are required");
        rawRepositories = body.allowedRepositoryIds ?? body.allowedRepositories;
        if (
          rawRepositories !== undefined &&
          (!Array.isArray(rawRepositories) ||
            !rawRepositories.every((value) => typeof value === "string" && value.length > 0))
        )
          throw new Error("allowedRepositories must be an array of non-empty strings");
        validateCredential(body.name, "name");
      } catch (error) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: error instanceof Error ? error.message : "invalid account",
          },
        });
        return true;
      }
      try {
        const result = await auth.createServiceAccount(
          {
            name: body.name,
            role: body.role,
            ...(rawRepositories ? { allowedRepositoryIds: rawRepositories as string[] } : {}),
            ...(typeof body.boundHostId === "string" ? { boundHostId: body.boundHostId } : {}),
          },
          plane.state.storage,
        );
        if (
          !(await audit(
            ctx,
            "service-account:create",
            "service-account",
            result.account.id,
            "success",
          ))
        )
          return true;
        send(res, 201, result);
      } catch (error) {
        if (!(await audit(ctx, "service-account:create", "service-account", "new", "failed")))
          return true;
        send(res, 500, {
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "internal server error",
          },
        });
      }
      return true;
    }
  }
  const serviceMatch = /^\/api\/v1\/auth\/service-accounts\/([^/]+)$/.exec(url.pathname);
  if (!serviceMatch || method !== "DELETE") return false;
  const id = decodeURIComponent(serviceMatch[1]!);
  const removed = await auth.deleteServiceAccount(id, plane.state.storage);
  if (
    !(await audit(
      ctx,
      "service-account:delete",
      "service-account",
      id,
      removed ? "success" : "failed",
    ))
  )
    return true;
  send(
    res,
    removed ? 204 : 404,
    removed ? null : { error: { code: "NOT_FOUND", message: "service account not found" } },
  );
  return true;
}

function isRole(value: unknown): value is Role {
  return value === "admin" || value === "operator" || value === "read-only";
}
