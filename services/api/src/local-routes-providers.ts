import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";

function providerUpdateError(error: string): { status: number; code: string } {
  if (/not found/i.test(error)) return { status: 404, code: "NOT_FOUND" };
  if (/already in use|already exists|attached|commands/i.test(error)) {
    return { status: 409, code: "CONFLICT" };
  }
  return { status: 400, code: "VALIDATION_ERROR" };
}

/** Provider CRUD routes. Returns true if handled. */
export async function handleProviderRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/providers") {
    send(res, 200, { items: plane.listProviders() });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/providers") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    try {
      const result = await plane.createProviderDurable({
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
      sendInternalError(res);
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
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
      try {
        const result = await plane.updateProviderDurable(id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.defaultCommandId === "string" || body.defaultCommandId === null
            ? { defaultCommandId: body.defaultCommandId }
            : {}),
        });
        if (!result.ok) {
          const mapped = providerUpdateError(result.error);
          send(res, mapped.status, { error: { code: mapped.code, message: result.error } });
          return true;
        }
        send(res, 200, result.provider);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      try {
        const result = await plane.deleteProviderDurable(id);
        if (!result.ok) {
          const status = plane.getProvider(id) ? 409 : 404;
          const code = status === 409 ? "CONFLICT" : "NOT_FOUND";
          send(res, status, { error: { code, message: result.error } });
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
