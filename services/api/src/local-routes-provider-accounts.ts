import { readJson, send, type RouteCtx } from "./local-http.ts";

/** Provider account CRUD routes. Returns true if handled. */
export async function handleProviderAccountRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/provider-accounts") {
    send(res, 200, { items: plane.listProviderAccounts() });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/provider-accounts") {
    try {
      const body = (await readJson(req)) as Record<string, unknown>;
      const result = plane.createProviderAccount({
        providerId: String(body.providerId ?? ""),
        label: String(body.label ?? ""),
      });
      if (!result.ok) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      send(res, 201, result.account);
      return true;
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
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
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        const result = plane.updateProviderAccount(id, {
          ...(typeof body.providerId === "string" ? { providerId: body.providerId } : {}),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
        });
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        send(res, 200, result.account);
        return true;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
    }
    if (method === "DELETE") {
      const result = plane.deleteProviderAccount(id);
      if (!result.ok) {
        send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
        return true;
      }
      send(res, 204, null);
      return true;
    }
  }
  return false;
}
