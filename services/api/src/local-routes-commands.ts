import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import type { ResumeRefCapture } from "@auto-harness/shared";

function commandPatchFromBody(body: Record<string, unknown>): {
  name?: string;
  argv?: string[];
  appendPrompt?: boolean;
  providerId?: string | null;
  resumeArgvTemplate?: string[] | null;
  resumeRefCapture?: ResumeRefCapture | null;
} {
  return {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(Array.isArray(body.argv) ? { argv: body.argv as string[] } : {}),
    ...(typeof body.appendPrompt === "boolean" ? { appendPrompt: body.appendPrompt } : {}),
    ...(typeof body.providerId === "string" || body.providerId === null
      ? { providerId: body.providerId }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "resumeArgvTemplate")
      ? { resumeArgvTemplate: body.resumeArgvTemplate as string[] | null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "resumeRefCapture")
      ? { resumeRefCapture: body.resumeRefCapture as ResumeRefCapture | null }
      : {}),
  };
}

/** Command CRUD routes. Returns true if handled. */
export async function handleCommandRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/commands") {
    send(res, 200, { items: plane.listCommands() });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/commands") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    try {
      const result = await plane.createCommandDurable({
        name: String(body.name ?? ""),
        argv: Array.isArray(body.argv) ? (body.argv as string[]) : [],
        ...commandPatchFromBody(body),
      });
      if (!result.ok) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      send(res, 201, result.command);
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }
  const match = /^\/api\/v1\/commands\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const id = match[1]!;
    if (method === "GET") {
      const command = plane.getCommand(id);
      if (!command) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "command not found" } });
        return true;
      }
      send(res, 200, command);
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
        const result = await plane.updateCommandDurable(id, commandPatchFromBody(body));
        if (!result.ok) {
          const status = plane.getCommand(id) ? 400 : 404;
          send(res, status, {
            error: {
              code: status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR",
              message: result.error,
            },
          });
          return true;
        }
        send(res, 200, result.command);
        return true;
      } catch {
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      try {
        const result = await plane.deleteCommandDurable(id);
        if (!result.ok) {
          const status = plane.getCommand(id) ? 409 : 404;
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
