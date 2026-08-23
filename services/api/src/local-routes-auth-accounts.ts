/* eslint-disable max-lines */
import type { IncomingMessage, ServerResponse } from "node:http";

import { isUserRole } from "@auto-harness/shared";

import { auditActor } from "./audit.ts";
import { assertAccountGrant, parseRepositoryScope, validateCredential } from "./auth-accounts.ts";
import type { AuthService, Principal } from "./auth.ts";
import {
  deleteConflict,
  dependenciesForPrincipal,
  referencesFromState,
  refreshDeleteReferences,
} from "./control-plane-delete-guards.ts";
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

async function accountDeleteConflict(
  plane: ControlPlane,
  principalId: string,
): Promise<ReturnType<typeof deleteConflict>> {
  const refs = plane.state.storage
    ? await refreshDeleteReferences(plane.state)
    : referencesFromState(plane.state);
  return deleteConflict("account", dependenciesForPrincipal(refs, principalId));
}

export async function handleAccountRoutes(ctx: AccountRouteCtx): Promise<boolean> {
  const { auth, plane, req, res, url, method } = ctx;
  if (url.pathname === "/api/v1/auth/users") {
    if (method === "GET") return (send(res, 200, { items: auth.listUsers() }), true);
    if (method === "POST") {
      let body: Record<string, unknown>;
      let allowedRepositoryIds: string[] | undefined;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.username !== "string" ||
          typeof body.password !== "string" ||
          !isUserRole(body.role)
        )
          throw new Error("username, password, and role are required");
        allowedRepositoryIds = parseRepositoryScope(body);
        validateCredential(body.username, "username");
        validateCredential(body.password, "password");
        assertAccountGrant(body.role, allowedRepositoryIds ? { allowedRepositoryIds } : {});
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
          {
            username: body.username,
            password: body.password,
            role: body.role,
            ...(allowedRepositoryIds ? { allowedRepositoryIds } : {}),
          },
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
    const user = auth.listUsers().find((candidate) => candidate.username === id);
    if (user) {
      const conflict = await accountDeleteConflict(plane, user.id);
      if (!conflict.ok) {
        if (!(await audit(ctx, "user:delete", "user", id, "failed"))) return true;
        send(res, 409, {
          error: {
            code: "CONFLICT",
            message: conflict.error,
            dependencies: conflict.dependencies,
          },
        });
        return true;
      }
    }
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
      let rawRepositories: string[] | undefined;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.name !== "string" ||
          !isUserRole(body.role)
        )
          throw new Error("name and role are required");
        rawRepositories = parseRepositoryScope(body);
        validateCredential(body.name, "name");
        assertAccountGrant(body.role, {
          ...(rawRepositories ? { allowedRepositoryIds: rawRepositories } : {}),
          ...(typeof body.boundHostId === "string" ? { boundHostId: body.boundHostId } : {}),
        });
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
            ...(rawRepositories ? { allowedRepositoryIds: rawRepositories } : {}),
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
  const account = auth.listServiceAccounts().find((candidate) => candidate.id === id);
  if (account) {
    const conflict = await accountDeleteConflict(plane, account.id);
    if (!conflict.ok) {
      if (!(await audit(ctx, "service-account:delete", "service-account", id, "failed")))
        return true;
      send(res, 409, {
        error: {
          code: "CONFLICT",
          message: conflict.error,
          dependencies: conflict.dependencies,
        },
      });
      return true;
    }
  }
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
