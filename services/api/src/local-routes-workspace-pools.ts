import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { readJsonBody, sendHiddenNotFound, sendRouteError } from "./local-audited-route.ts";
import { writeRouteAudit } from "./local-audit.ts";
import type { WorkspacePoolInput } from "./control-plane-workspace-pools.ts";

function poolInput(
  body: Record<string, unknown>,
  requireName: boolean,
): WorkspacePoolInput | Partial<Omit<WorkspacePoolInput, "id">> {
  return {
    ...(typeof body.name === "string" ? { name: body.name } : requireName ? { name: "" } : {}),
    ...(Array.isArray(body.setupProfiles) ? { setupProfiles: body.setupProfiles as never } : {}),
    ...(typeof body.defaultSetupProfileId === "string" || body.defaultSetupProfileId === null
      ? { defaultSetupProfileId: body.defaultSetupProfileId }
      : {}),
    ...(typeof body.destroyWorkspaceAfter === "boolean"
      ? { destroyWorkspaceAfter: body.destroyWorkspaceAfter }
      : {}),
  };
}

/** Global workspace-pool configuration. Raw scripts are accepted only on these admin routes. */
export async function handleWorkspacePoolRoutes(ctx: RouteCtx): Promise<boolean> {
  const { method, plane, res, url } = ctx;
  const poolPath =
    url.pathname === "/api/v1/workspace-pools" ||
    url.pathname.startsWith("/api/v1/workspace-pools/");
  if (!poolPath) return false;
  if (ctx.principal?.allowedRepositoryIds) {
    sendHiddenNotFound(res);
    return true;
  }
  if (url.pathname === "/api/v1/workspace-pools") {
    if (method === "GET") {
      try {
        await plane.listWorkspacePoolsDurable();
        send(res, 200, { items: plane.listWorkspacePoolsPublic() });
      } catch {
        sendInternalError(res);
      }
      return true;
    }
    if (method === "POST") {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok) return true;
      try {
        const result = await plane.createWorkspacePoolDurable(
          poolInput(parsed.body as Record<string, unknown>, true) as WorkspacePoolInput,
        );
        if (!result.ok) {
          sendRouteError(res, 400, "VALIDATION_ERROR", result.error);
          return true;
        }
        await writeRouteAudit(ctx, {
          action: "workspace-pool:create",
          resourceType: "workspace-pool",
          resourceId: result.workspacePool.id,
        });
        send(res, 201, result.workspacePool);
      } catch {
        sendInternalError(res);
      }
      return true;
    }
  }
  const match = /^\/api\/v1\/workspace-pools\/([^/]+)$/.exec(url.pathname);
  const execConfigMatch = /^\/api\/v1\/workspace-pools\/([^/]+)\/exec-config$/.exec(url.pathname);
  if (execConfigMatch && method === "GET") {
    try {
      const pool = await plane.getWorkspacePoolDurable(decodeURIComponent(execConfigMatch[1]!));
      if (!pool) sendRouteError(res, 404, "NOT_FOUND", "workspace pool not found");
      else send(res, 200, pool);
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (!match) return false;
  const id = decodeURIComponent(match[1]!);
  if (method === "GET") {
    try {
      const pool = await plane.getWorkspacePoolDurable(id);
      if (!pool) sendRouteError(res, 404, "NOT_FOUND", "workspace pool not found");
      else {
        await plane.listWorkspacePoolsDurable();
        send(
          res,
          200,
          plane.listWorkspacePoolsPublic().find((item) => item.id === id),
        );
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (method === "PUT" || method === "PATCH") {
    const parsed = await readJsonBody(ctx);
    if (!parsed.ok) return true;
    try {
      const result = await plane.updateWorkspacePoolDurable(
        id,
        poolInput(parsed.body as Record<string, unknown>, method === "PUT") as Partial<
          Omit<WorkspacePoolInput, "id">
        >,
      );
      if (!result.ok) {
        sendRouteError(
          res,
          result.error === "workspace pool not found" ? 404 : 400,
          result.error === "workspace pool not found" ? "NOT_FOUND" : "VALIDATION_ERROR",
          result.error,
        );
      } else {
        await writeRouteAudit(ctx, {
          action: "workspace-pool:update",
          resourceType: "workspace-pool",
          resourceId: id,
        });
        send(res, 200, result.workspacePool);
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (method === "DELETE") {
    try {
      const result = await plane.deleteWorkspacePoolDurable(id);
      if (!result.ok) {
        sendRouteError(
          res,
          result.error === "workspace pool not found" ? 404 : 409,
          result.error === "workspace pool not found" ? "NOT_FOUND" : "CONFLICT",
          result.error,
        );
      } else {
        await writeRouteAudit(ctx, {
          action: "workspace-pool:delete",
          resourceType: "workspace-pool",
          resourceId: id,
        });
        send(res, 204, null);
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  return false;
}
