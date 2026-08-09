import type { IncomingMessage, ServerResponse } from "node:http";

import { type AuthService, type Role } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";
import { readJson, send } from "./local-http.ts";

type AuthRouteContext = {
  auth: AuthService;
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
};

/** Login/logout and admin-only durable account-management routes. */
export async function handleAuthRoutes(ctx: AuthRouteContext): Promise<boolean> {
  const { auth, plane, req, res, url, method } = ctx;
  if (method === "POST" && url.pathname === "/api/v1/auth/login") {
    try {
      const basic = await auth.authenticate(req);
      const body = basic ? null : ((await readJson(req)) as Record<string, unknown>);
      const principal =
        basic ??
        (typeof body?.username === "string" && typeof body.password === "string"
          ? await auth.authenticatePassword(body.username, body.password)
          : null);
      if (!principal) {
        send(res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid credentials" } });
        return true;
      }
      auth.issueCookie(res, principal);
      send(res, 200, { principal });
    } catch {
      send(res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid credentials" } });
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/auth/logout") {
    auth.clearCookie(res);
    send(res, 204, null);
    return true;
  }
  if (url.pathname === "/api/v1/auth/users") {
    if (method === "GET") {
      send(res, 200, { items: auth.listUsers() });
      return true;
    }
    if (method === "POST") {
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (
          typeof body.username !== "string" ||
          typeof body.password !== "string" ||
          !isRole(body.role)
        )
          throw new Error("username, password, and role are required");
        const user = await auth.createUser(
          { username: body.username, password: body.password, role: body.role },
          plane.state.storage,
        );
        send(res, 201, user);
      } catch (error) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: error instanceof Error ? error.message : "invalid account",
          },
        });
      }
      return true;
    }
  }
  const userMatch = /^\/api\/v1\/auth\/users\/([^/]+)$/.exec(url.pathname);
  if (userMatch && method === "DELETE") {
    const removed = await auth.deleteUser(decodeURIComponent(userMatch[1]!), plane.state.storage);
    send(
      res,
      removed ? 204 : 404,
      removed ? null : { error: { code: "NOT_FOUND", message: "user not found" } },
    );
    return true;
  }
  if (url.pathname === "/api/v1/auth/service-accounts") {
    if (method === "GET") {
      send(res, 200, { items: auth.listServiceAccounts() });
      return true;
    }
    if (method === "POST") {
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (typeof body.name !== "string" || !isRole(body.role))
          throw new Error("name and role are required");
        const rawRepositories = body.allowedRepositoryIds ?? body.allowedRepositories;
        if (
          rawRepositories !== undefined &&
          (!Array.isArray(rawRepositories) ||
            !rawRepositories.every((value) => typeof value === "string" && value.length > 0))
        ) {
          throw new Error("allowedRepositories must be an array of non-empty strings");
        }
        const allowedRepositoryIds = rawRepositories as string[] | undefined;
        const result = await auth.createServiceAccount(
          {
            name: body.name,
            role: body.role,
            ...(allowedRepositoryIds ? { allowedRepositoryIds } : {}),
            ...(typeof body.boundHostId === "string" ? { boundHostId: body.boundHostId } : {}),
          },
          plane.state.storage,
        );
        send(res, 201, result);
      } catch (error) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: error instanceof Error ? error.message : "invalid account",
          },
        });
      }
      return true;
    }
  }
  const serviceMatch = /^\/api\/v1\/auth\/service-accounts\/([^/]+)$/.exec(url.pathname);
  if (serviceMatch && method === "DELETE") {
    const removed = await auth.deleteServiceAccount(
      decodeURIComponent(serviceMatch[1]!),
      plane.state.storage,
    );
    send(
      res,
      removed ? 204 : 404,
      removed ? null : { error: { code: "NOT_FOUND", message: "service account not found" } },
    );
    return true;
  }
  return false;
}

function isRole(value: unknown): value is Role {
  return value === "admin" || value === "operator" || value === "read-only";
}
