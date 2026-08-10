import { type AuthService, type Role } from "./auth.ts";
import { validateCredential } from "./auth-accounts.ts";
import { readJson, send, sendInternalError } from "./local-http.ts";
import {
  handleSelfServiceAuthRoutes,
  type SelfServiceAuthRouteContext,
} from "./local-routes-auth-self-service.ts";

type AuthRouteContext = SelfServiceAuthRouteContext;

/** Login/logout and admin-only durable account-management routes. */
export async function handleAuthRoutes(ctx: AuthRouteContext): Promise<boolean> {
  const { auth, plane, req, res, url, method } = ctx;
  if (method === "POST" && url.pathname === "/api/v1/auth/login") {
    let basic: Awaited<ReturnType<typeof auth.authenticate>>;
    try {
      basic = await auth.authenticate(req);
    } catch {
      sendInternalError(res);
      return true;
    }
    let body: Record<string, unknown> | null = null;
    if (!basic) {
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
    }
    try {
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
      sendInternalError(res);
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/auth/logout") {
    auth.clearCookie(res);
    send(res, 204, null);
    return true;
  }
  if (await handleSelfServiceAuthRoutes(ctx)) return true;
  if (url.pathname === "/api/v1/auth/users") {
    if (method === "GET") {
      send(res, 200, { items: auth.listUsers() });
      return true;
    }
    if (method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
      if (
        !isRecord(body) ||
        typeof body.username !== "string" ||
        typeof body.password !== "string" ||
        !isRole(body.role)
      ) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "username, password, and role are required" },
        });
        return true;
      }
      try {
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
        send(res, 201, user);
      } catch (error) {
        if (error instanceof Error && error.message === "username already exists") {
          send(res, 409, { error: { code: "CONFLICT", message: error.message } });
        } else {
          sendInternalError(res);
        }
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
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
      if (!isRecord(body) || typeof body.name !== "string" || !isRole(body.role)) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "name and role are required" },
        });
        return true;
      }
      const rawRepositories = body.allowedRepositoryIds ?? body.allowedRepositories;
      if (
        rawRepositories !== undefined &&
        (!Array.isArray(rawRepositories) ||
          !rawRepositories.every((value) => typeof value === "string" && value.length > 0))
      ) {
        send(res, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: "allowedRepositories must be an array of non-empty strings",
          },
        });
        return true;
      }
      try {
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
      } catch {
        sendInternalError(res);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
