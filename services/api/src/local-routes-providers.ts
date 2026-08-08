import { readJson, send, type RouteCtx } from "./local-http.ts";

/** Provider CRUD routes. Returns true if handled. */
export async function handleProviderRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/providers") {
    send(res, 200, { items: plane.listProviders() });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/providers") {
    try {
      const body = (await readJson(req)) as Record<string, unknown>;
      const result = plane.createProvider({
        name: String(body.name ?? ""),
        ...(typeof body.defaultCommandId === "string" || body.defaultCommandId === null
          ? { defaultCommandId: body.defaultCommandId }
          : {}),
      });
      if (!result.ok) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      send(res, 201, result.provider);
      return true;
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
  }
  const match = /^\/api\/v1\/providers\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const id = match[1]!;
    if (method === "GET") {
      const provider = plane.getProvider(id);
      if (!provider) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "provider not found" } });
        return true;
      }
      send(res, 200, provider);
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        const result = plane.updateProvider(id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.defaultCommandId === "string" || body.defaultCommandId === null
            ? { defaultCommandId: body.defaultCommandId }
            : {}),
        });
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return true;
        }
        send(res, 200, result.provider);
        return true;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
    }
    if (method === "DELETE") {
      const result = plane.deleteProvider(id);
      if (!result.ok) {
        const status = plane.getProvider(id) ? 409 : 404;
        const code = status === 409 ? "CONFLICT" : "NOT_FOUND";
        send(res, status, { error: { code, message: result.error } });
        return true;
      }
      send(res, 204, null);
      return true;
    }
  }
  return false;
}
