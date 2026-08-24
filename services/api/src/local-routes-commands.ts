import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { commitMutationAudit, readJsonBody, sendRouteError } from "./local-audited-route.ts";
import { commandPatchFromBody } from "./local-routes-command-patch.ts";

/** Command CRUD routes. Returns true if handled. */
export async function handleCommandRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/commands") {
    try {
      send(res, 200, { items: await plane.listCommandsDurable() });
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/commands") {
    const parsed = await readJsonBody(ctx);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    try {
      const result = await plane.createCommandDurable({
        name: String(body.name ?? ""),
        argv: Array.isArray(body.argv) ? (body.argv as string[]) : [],
        ...commandPatchFromBody(body),
      });
      if (!result.ok) {
        if (
          !(await commitMutationAudit(ctx, {
            action: "command:create",
            resourceType: "command",
            resourceId: "new",
            outcome: "failed",
          }))
        )
          return true;
        sendRouteError(res, 400, "VALIDATION_ERROR", result.error);
        return true;
      }
      if (
        !(await commitMutationAudit(ctx, {
          action: "command:create",
          resourceType: "command",
          resourceId: result.command.id,
          metadata: { providerId: result.command.providerId ?? "none" },
        }))
      )
        return true;
      send(res, 201, result.command);
      return true;
    } catch {
      if (
        !(await commitMutationAudit(ctx, {
          action: "command:create",
          resourceType: "command",
          resourceId: "new",
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
      return true;
    }
  }
  const match = /^\/api\/v1\/commands\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const id = match[1]!;
    if (method === "GET") {
      try {
        const command = await plane.getCommandDurable(id);
        if (!command) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "command not found" } });
          return true;
        }
        send(res, 200, command);
      } catch {
        sendInternalError(res);
      }
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok) return true;
      const body = parsed.body as Record<string, unknown>;
      try {
        const result = await plane.updateCommandDurable(id, commandPatchFromBody(body));
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "command:update",
              resourceType: "command",
              resourceId: id,
              outcome: "failed",
            }))
          )
            return true;
          const status = plane.getCommand(id) ? 400 : 404;
          send(res, status, {
            error: {
              code: status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR",
              message: result.error,
            },
          });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "command:update",
            resourceType: "command",
            resourceId: result.command.id,
            metadata: { providerId: result.command.providerId ?? "none" },
          }))
        )
          return true;
        send(res, 200, result.command);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "command:update",
            resourceType: "command",
            resourceId: id,
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      try {
        const result = await plane.deleteCommandDurable(id);
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "command:delete",
              resourceType: "command",
              resourceId: id,
              outcome: "failed",
            }))
          )
            return true;
          const status = result.conflict ? 409 : 404;
          const code = status === 409 ? "CONFLICT" : "NOT_FOUND";
          send(res, status, {
            error: {
              code,
              message: result.error,
              ...(result.dependencies ? { dependencies: result.dependencies } : {}),
            },
          });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "command:delete",
            resourceType: "command",
            resourceId: id,
          }))
        )
          return true;
        send(res, 204, null);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "command:delete",
            resourceType: "command",
            resourceId: id,
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
        return true;
      }
    }
  }
  return false;
}
