import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { assignQueuedDurable } from "./control-plane-assign.ts";

/** Provider account CRUD routes. Returns true if handled. */
export async function handleProviderAccountRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/provider-accounts") {
    send(res, 200, { items: plane.listProviderAccounts() });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/provider-accounts") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    try {
      const result = await plane.createProviderAccountDurable({
        providerId: String(body.providerId ?? ""),
        label: String(body.label ?? ""),
        ...(typeof body.usageLimitCooldownSeconds === "number"
          ? { usageLimitCooldownSeconds: body.usageLimitCooldownSeconds }
          : {}),
      });
      if (!result.ok) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      send(res, 201, result.account);
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }
  const clearMatch = /^\/api\/v1\/provider-accounts\/([^/]+)\/usage-limit$/.exec(url.pathname);
  if (method === "DELETE" && clearMatch) {
    let result: Awaited<ReturnType<typeof plane.clearProviderAccountUsageLimitDurable>>;
    try {
      result = await plane.clearProviderAccountUsageLimitDurable(clearMatch[1]!);
    } catch {
      sendInternalError(res);
      return true;
    }
    if (!result.ok) {
      send(res, result.conflict ? 409 : 404, {
        error: { code: result.conflict ? "CONFLICT" : "NOT_FOUND", message: result.error },
      });
      return true;
    }
    await assignQueuedDurable(plane.state);
    send(res, 200, result.account);
    return true;
  }
  const match = /^\/api\/v1\/provider-accounts\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const id = match[1]!;
    if (method === "GET") {
      const account = plane.getProviderAccount(id);
      if (!account) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "provider account not found" } });
        return true;
      }
      send(res, 200, account);
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
      try {
        const result = await plane.updateProviderAccountDurable(id, {
          ...(typeof body.providerId === "string" ? { providerId: body.providerId } : {}),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.usageLimitCooldownSeconds === "number"
            ? { usageLimitCooldownSeconds: body.usageLimitCooldownSeconds }
            : {}),
        });
        if (!result.ok) {
          const status = result.conflict ? 409 : 404;
          send(res, status, {
            error: { code: result.conflict ? "CONFLICT" : "NOT_FOUND", message: result.error },
          });
          return true;
        }
        send(res, 200, result.account);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      try {
        const result = await plane.deleteProviderAccountDurable(id);
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        send(res, 204, null);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
  }
  return false;
}
